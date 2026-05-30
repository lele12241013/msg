const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { exec, execFile } = require('child_process');
const express = require('express');

const PORT = Number(process.env.PORT || 3471);
const HOST = '127.0.0.1';
const DEFAULT_DURATION_MS = 5000;
const runtimeArgs = new Set(process.argv.slice(2));
const shouldOpenPanelOnLaunch = !runtimeArgs.has('--silent') && process.env.POPUP_APP_OPEN_PANEL !== '0';
const defaultPopupSettings = {
  backgroundColor: '#fff3dd',
  accentColor: '#ff9f1c',
  textColor: '#132a32',
  width: 430,
  height: 190,
  fontSize: 18,
  opacity: 92,
};
const defaultRemoteConfig = {
  enabled: false,
  rawUrl: '',
  deviceKey: 'notebook-1',
  pollIntervalMs: 15000,
};
const settingsDirectory = process.pkg
  ? path.join(process.env.LOCALAPPDATA || __dirname, 'PopupRemoto')
  : path.join(__dirname, '.popup-remoto');
const settingsPath = path.join(settingsDirectory, 'settings.json');
const remoteConfigPath = path.join(settingsDirectory, 'remote-config.json');
const remoteStatePath = path.join(settingsDirectory, 'remote-state.json');

let popupInFlight = false;
let popupSettings = loadPopupSettings();
let remoteConfig = loadRemoteConfig();
let remoteState = loadRemoteState();
let remotePollTimer = null;
let remotePollInFlight = false;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function sanitizeHexColor(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized : fallback;
}

function normalizePopupSettings(input = {}) {
  return {
    backgroundColor: sanitizeHexColor(input.backgroundColor, defaultPopupSettings.backgroundColor),
    accentColor: sanitizeHexColor(input.accentColor, defaultPopupSettings.accentColor),
    textColor: sanitizeHexColor(input.textColor, defaultPopupSettings.textColor),
    width: clamp(Number(input.width) || defaultPopupSettings.width, 280, 720),
    height: clamp(Number(input.height) || defaultPopupSettings.height, 120, 360),
    fontSize: clamp(Number(input.fontSize) || defaultPopupSettings.fontSize, 12, 32),
    opacity: clamp(Number(input.opacity) || defaultPopupSettings.opacity, 35, 100),
  };
}

function ensureSettingsDirectory() {
  fs.mkdirSync(settingsDirectory, { recursive: true });
}

function loadPopupSettings() {
  try {
    if (!fs.existsSync(settingsPath)) {
      return { ...defaultPopupSettings };
    }

    const rawContent = fs.readFileSync(settingsPath, 'utf8');
    return normalizePopupSettings(JSON.parse(rawContent));
  } catch {
    return { ...defaultPopupSettings };
  }
}

function savePopupSettings(nextSettings) {
  popupSettings = normalizePopupSettings(nextSettings);
  ensureSettingsDirectory();
  fs.writeFileSync(settingsPath, JSON.stringify(popupSettings, null, 2));
  return popupSettings;
}

function normalizeRemoteConfig(input = {}) {
  return {
    enabled: input.enabled === true || input.enabled === 'true',
    rawUrl: typeof input.rawUrl === 'string' ? input.rawUrl.trim() : '',
    deviceKey: typeof input.deviceKey === 'string' && input.deviceKey.trim()
      ? input.deviceKey.trim()
      : defaultRemoteConfig.deviceKey,
    pollIntervalMs: clamp(Number(input.pollIntervalMs) || defaultRemoteConfig.pollIntervalMs, 5000, 300000),
  };
}

function loadRemoteConfig() {
  try {
    if (!fs.existsSync(remoteConfigPath)) {
      return { ...defaultRemoteConfig };
    }

    return normalizeRemoteConfig(JSON.parse(fs.readFileSync(remoteConfigPath, 'utf8')));
  } catch {
    return { ...defaultRemoteConfig };
  }
}

function saveRemoteConfig(nextConfig) {
  remoteConfig = normalizeRemoteConfig(nextConfig);
  ensureSettingsDirectory();
  fs.writeFileSync(remoteConfigPath, JSON.stringify(remoteConfig, null, 2));
  return remoteConfig;
}

function loadRemoteState() {
  try {
    if (!fs.existsSync(remoteStatePath)) {
      return { lastCommandId: '' };
    }

    const parsed = JSON.parse(fs.readFileSync(remoteStatePath, 'utf8'));
    return {
      lastCommandId: typeof parsed.lastCommandId === 'string' ? parsed.lastCommandId : '',
    };
  } catch {
    return { lastCommandId: '' };
  }
}

function saveRemoteState(nextState) {
  remoteState = {
    lastCommandId: typeof nextState.lastCommandId === 'string' ? nextState.lastCommandId : '',
  };
  ensureSettingsDirectory();
  fs.writeFileSync(remoteStatePath, JSON.stringify(remoteState, null, 2));
  return remoteState;
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    let parsedUrl;

    try {
      parsedUrl = new URL(url);
    } catch {
      reject(new Error('URL remota invalida.'));
      return;
    }

    const client = parsedUrl.protocol === 'https:' ? https : http;

    const request = client.get(
      parsedUrl,
      {
        headers: {
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
          'User-Agent': 'PopupRemoto/1.0',
          Accept: 'application/json',
        },
      },
      (response) => {
        let body = '';

        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });

        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`Falha ao consultar origem remota: HTTP ${response.statusCode}`));
            return;
          }

          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('A origem remota nao retornou JSON valido.'));
          }
        });
      }
    );

    request.on('error', reject);
  });
}

async function pollRemoteCommand() {
  if (!remoteConfig.enabled || !remoteConfig.rawUrl || remotePollInFlight) {
    return;
  }

  remotePollInFlight = true;

  try {
    const separator = remoteConfig.rawUrl.includes('?') ? '&' : '?';
    const payload = await requestJson(`${remoteConfig.rawUrl}${separator}t=${Date.now()}`);
    const commandId = typeof payload.id === 'string' ? payload.id.trim() : '';
    const target = typeof payload.target === 'string' ? payload.target.trim() : '';
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    const rawDuration = Number(payload.durationMs);
    const durationMs = Number.isFinite(rawDuration)
      ? Math.min(Math.max(rawDuration, 1500), 30000)
      : DEFAULT_DURATION_MS;

    if (!commandId || !message || commandId === remoteState.lastCommandId) {
      return;
    }

    if (target && remoteConfig.deviceKey && target !== remoteConfig.deviceKey) {
      return;
    }

    const shown = showPopup(message, durationMs, normalizePopupSettings(payload.settings || popupSettings));

    if (shown) {
      saveRemoteState({ lastCommandId: commandId });
    }
  } catch (error) {
    console.error('Falha no modo remoto:', error.message);
  } finally {
    remotePollInFlight = false;
  }
}

function restartRemotePolling() {
  if (remotePollTimer) {
    clearInterval(remotePollTimer);
    remotePollTimer = null;
  }

  if (!remoteConfig.enabled || !remoteConfig.rawUrl) {
    return;
  }

  pollRemoteCommand();
  remotePollTimer = setInterval(pollRemoteCommand, remoteConfig.pollIntervalMs);
}

function openControlPanel() {
  exec(`cmd /c start "" "http://${HOST}:${PORT}"`);
}

function getControlPanelHtml(settings) {
  const initialSettings = JSON.stringify(settings);
  const defaultSettingsJson = JSON.stringify(defaultPopupSettings);

  return `<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Controle de Popup</title>
    <style>
      :root {
        color-scheme: light;
        font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
        --bg: #f7f3ea;
        --panel: rgba(255, 255, 255, 0.78);
        --ink: #172121;
        --accent: #d96c06;
        --accent-dark: #9c4300;
        --muted: rgba(23, 33, 33, 0.62);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        color: var(--ink);
        background:
          radial-gradient(circle at top right, rgba(217, 108, 6, 0.18), transparent 28%),
          radial-gradient(circle at bottom left, rgba(18, 44, 52, 0.16), transparent 25%),
          linear-gradient(135deg, #f8f4ec, #efe7da 55%, #f6efe4);
      }

      main {
        width: min(1080px, calc(100vw - 32px));
        margin: 48px auto;
        padding: 28px;
        border-radius: 24px;
        background: var(--panel);
        backdrop-filter: blur(18px);
        box-shadow: 0 24px 70px rgba(18, 44, 52, 0.15);
        border: 1px solid rgba(255, 255, 255, 0.7);
      }

      h1 {
        margin: 0 0 12px;
        font-size: clamp(2rem, 4vw, 3.2rem);
        line-height: 1;
      }

      p {
        margin: 0 0 18px;
        font-size: 1rem;
        line-height: 1.6;
      }

      .layout {
        display: grid;
        grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr);
        gap: 24px;
        align-items: start;
      }

      .panel-block {
        padding: 22px;
        border-radius: 22px;
        background: rgba(255, 255, 255, 0.58);
        border: 1px solid rgba(23, 33, 33, 0.08);
      }

      .eyebrow {
        margin-bottom: 8px;
        font-size: 0.82rem;
        font-weight: 800;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--muted);
      }

      form {
        display: grid;
        gap: 14px;
      }

      .settings-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
      }

      .field {
        display: grid;
        gap: 8px;
      }

      .field span {
        font-size: 0.94rem;
        font-weight: 700;
      }

      label {
        font-weight: 700;
      }

      textarea,
      input,
      select,
      button {
        width: 100%;
        border-radius: 16px;
        border: 1px solid rgba(23, 33, 33, 0.14);
        font: inherit;
      }

      textarea,
      input,
      select {
        padding: 14px 16px;
        background: rgba(255, 255, 255, 0.82);
      }

      input[type="color"] {
        min-height: 56px;
        padding: 6px;
        cursor: pointer;
      }

      input[type="range"] {
        padding: 0;
      }

      textarea {
        min-height: 150px;
        resize: vertical;
      }

      .inline-control {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 88px;
        gap: 10px;
        align-items: center;
      }

      .button-row {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
      }

      button {
        padding: 16px;
        font-weight: 700;
        color: white;
        background: linear-gradient(135deg, var(--accent), var(--accent-dark));
        cursor: pointer;
      }

      button:hover {
        filter: brightness(1.04);
      }

      .status {
        min-height: 24px;
        margin-top: 12px;
        font-weight: 700;
      }

      .status.is-error {
        color: #9f1d1d;
      }

      .status.is-success {
        color: #0e6245;
      }

      .hint {
        margin-top: 18px;
        padding: 14px 16px;
        border-radius: 16px;
        background: rgba(18, 44, 52, 0.08);
      }

      .preview-shell {
        padding: 22px;
        min-height: 360px;
        border-radius: 24px;
        background:
          radial-gradient(circle at top right, rgba(255, 159, 28, 0.15), transparent 30%),
          linear-gradient(180deg, rgba(19, 42, 50, 0.1), rgba(19, 42, 50, 0.02));
        position: sticky;
        top: 24px;
        overflow: hidden;
      }

      .preview-caption {
        margin-bottom: 16px;
        color: var(--muted);
        font-size: 0.95rem;
      }

      .popup-preview-frame {
        min-height: 250px;
        display: flex;
        align-items: flex-start;
        justify-content: flex-end;
      }

      .popup-preview {
        position: relative;
        border-radius: 28px;
        padding: 18px 20px 20px 26px;
        box-shadow: 0 26px 60px rgba(0, 0, 0, 0.22);
        overflow: hidden;
      }

      .popup-preview::before {
        content: "";
        position: absolute;
        inset: 0 auto 0 0;
        width: 10px;
        background: var(--preview-accent, #ff9f1c);
      }

      .popup-preview::after {
        content: "";
        position: absolute;
        inset: 0;
        background: linear-gradient(135deg, rgba(255,255,255,0.26), transparent 40%);
        pointer-events: none;
      }

      .preview-message {
        position: relative;
        margin: 0;
        line-height: 1.3;
        font-weight: 800;
        word-break: break-word;
      }

      @media (max-width: 920px) {
        .layout {
          grid-template-columns: 1fr;
        }

        .preview-shell {
          position: static;
        }
      }

      @media (max-width: 640px) {
        .settings-grid {
          grid-template-columns: 1fr;
        }

        .inline-control {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <p>Painel local</p>
      <h1>Enviar popup para a tela</h1>
      <p>Agora o painel tambem funciona como editor visual do popup. Voce pode mudar cores, tamanho, cor da letra, tamanho do texto e transparencia, salvar o estilo e usar na hora.</p>

      <div class="layout">
        <section class="panel-block">
          <p class="eyebrow">Mensagem</p>
          <form id="popup-form">
            <div>
              <label for="message">Texto do popup</label>
              <textarea id="message" name="message" placeholder="Digite a mensagem que deve aparecer na tela" required>Seu texto vai aparecer aqui.</textarea>
            </div>

            <div>
              <label for="durationMs">Duracao em milissegundos</label>
              <input id="durationMs" name="durationMs" type="number" min="1500" max="30000" value="5000" />
            </div>

            <p class="eyebrow">Estilo do popup</p>

            <div class="settings-grid">
              <label class="field">
                <span>Cor de fundo</span>
                <input id="backgroundColor" name="backgroundColor" type="color" />
              </label>

              <label class="field">
                <span>Cor da faixa lateral</span>
                <input id="accentColor" name="accentColor" type="color" />
              </label>

              <label class="field">
                <span>Cor do texto</span>
                <input id="textColor" name="textColor" type="color" />
              </label>

              <label class="field">
                <span>Largura do popup</span>
                <div class="inline-control">
                  <input id="width" name="width" type="range" min="280" max="720" step="10" />
                  <input id="widthValue" type="number" min="280" max="720" step="10" />
                </div>
              </label>

              <label class="field">
                <span>Altura do popup</span>
                <div class="inline-control">
                  <input id="height" name="height" type="range" min="120" max="360" step="10" />
                  <input id="heightValue" type="number" min="120" max="360" step="10" />
                </div>
              </label>

              <label class="field">
                <span>Tamanho da letra</span>
                <div class="inline-control">
                  <input id="fontSize" name="fontSize" type="range" min="12" max="32" step="1" />
                  <input id="fontSizeValue" type="number" min="12" max="32" step="1" />
                </div>
              </label>

              <label class="field">
                <span>Transparencia</span>
                <div class="inline-control">
                  <input id="opacity" name="opacity" type="range" min="35" max="100" step="1" />
                  <input id="opacityValue" type="number" min="35" max="100" step="1" />
                </div>
              </label>
            </div>

            <div class="button-row">
              <button type="submit">Mostrar popup</button>
              <button type="button" id="save-settings">Salvar estilo</button>
              <button type="button" id="reset-settings">Restaurar padrao</button>
            </div>
          </form>

          <p class="status" id="status"></p>

        </section>

        <aside class="preview-shell">
          <p class="eyebrow">Preview</p>
          <p class="preview-caption">Ajuste os controles para ver como o popup vai aparecer na tela.</p>
          <div class="popup-preview-frame">
            <article class="popup-preview" id="popup-preview">
              <p class="preview-message" id="preview-message">Seu texto vai aparecer aqui.</p>
            </article>
          </div>
        </aside>
      </div>
    </main>

    <script>
      const defaultSettings = ${defaultSettingsJson};
      let currentSettings = ${initialSettings};
      const form = document.getElementById('popup-form');
      const status = document.getElementById('status');
      const preview = document.getElementById('popup-preview');
      const previewMessage = document.getElementById('preview-message');
      const saveButton = document.getElementById('save-settings');
      const resetButton = document.getElementById('reset-settings');

      const fieldIds = [
        'backgroundColor',
        'accentColor',
        'textColor',
        'width',
        'height',
        'fontSize',
        'opacity',
      ];

      const pairedFields = [
        ['width', 'widthValue'],
        ['height', 'heightValue'],
        ['fontSize', 'fontSizeValue'],
        ['opacity', 'opacityValue'],
      ];

      function setStatus(message, kind = '') {
        status.textContent = message;
        status.className = 'status';

        if (kind) {
          status.classList.add(kind === 'error' ? 'is-error' : 'is-success');
        }
      }

      function syncPairedFields() {
        pairedFields.forEach(([rangeId, numberId]) => {
          const range = document.getElementById(rangeId);
          const number = document.getElementById(numberId);

          range.addEventListener('input', () => {
            number.value = range.value;
            applyPreview();
          });

          number.addEventListener('input', () => {
            range.value = number.value;
            applyPreview();
          });
        });
      }

      function readSettingsFromForm() {
        return {
          backgroundColor: document.getElementById('backgroundColor').value,
          accentColor: document.getElementById('accentColor').value,
          textColor: document.getElementById('textColor').value,
          width: Number(document.getElementById('widthValue').value || document.getElementById('width').value || defaultSettings.width),
          height: Number(document.getElementById('heightValue').value || document.getElementById('height').value || defaultSettings.height),
          fontSize: Number(document.getElementById('fontSizeValue').value || document.getElementById('fontSize').value || defaultSettings.fontSize),
          opacity: Number(document.getElementById('opacityValue').value || document.getElementById('opacity').value || defaultSettings.opacity),
        };
      }

      function writeSettingsToForm(settings) {
        fieldIds.forEach((id) => {
          const input = document.getElementById(id);
          if (input) {
            input.value = settings[id];
          }
        });

        document.getElementById('widthValue').value = settings.width;
        document.getElementById('heightValue').value = settings.height;
        document.getElementById('fontSizeValue').value = settings.fontSize;
        document.getElementById('opacityValue').value = settings.opacity;
      }

      function applyPreview() {
        currentSettings = readSettingsFromForm();
        const previewText = String(document.getElementById('message').value || 'Seu texto vai aparecer aqui.').trim() || 'Seu texto vai aparecer aqui.';

        preview.style.width = currentSettings.width + 'px';
        preview.style.minHeight = currentSettings.height + 'px';
        preview.style.background = currentSettings.backgroundColor;
        preview.style.color = currentSettings.textColor;
        preview.style.opacity = String(currentSettings.opacity / 100);
        preview.style.setProperty('--preview-accent', currentSettings.accentColor);

        previewMessage.style.color = currentSettings.textColor;
        previewMessage.style.fontSize = currentSettings.fontSize + 'px';
        previewMessage.textContent = previewText;
      }

      async function saveSettings(settings) {
        const response = await fetch('/api/settings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(settings),
        });

        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.error || 'Falha ao salvar configuracoes.');
        }

        currentSettings = result.settings;
        writeSettingsToForm(currentSettings);
        applyPreview();
      }

      fieldIds.forEach((id) => {
        const input = document.getElementById(id);
        input.addEventListener('input', applyPreview);
      });

      document.getElementById('message').addEventListener('input', applyPreview);
      document.getElementById('durationMs').addEventListener('input', applyPreview);
      syncPairedFields();
      writeSettingsToForm(currentSettings);
      applyPreview();

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        setStatus('Enviando...');

        const formData = new FormData(form);
        const payload = {
          message: String(formData.get('message') || ''),
          durationMs: Number(formData.get('durationMs') || 5000),
          settings: readSettingsFromForm(),
        };

        try {
          const response = await fetch('/api/popup', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
          });

          const result = await response.json();

          if (!response.ok) {
            throw new Error(result.error || 'Falha ao enviar popup.');
          }

          setStatus('Popup enviado com sucesso.', 'success');
        } catch (error) {
          setStatus(error.message, 'error');
        }
      });

      saveButton.addEventListener('click', async () => {
        setStatus('Salvando estilo...');

        try {
          await saveSettings(readSettingsFromForm());
          setStatus('Estilo salvo com sucesso.', 'success');
        } catch (error) {
          setStatus(error.message, 'error');
        }
      });

      resetButton.addEventListener('click', async () => {
        writeSettingsToForm(defaultSettings);
        applyPreview();
        setStatus('Restaurando estilo padrao...');

        try {
          await saveSettings(defaultSettings);
          setStatus('Estilo padrao restaurado.', 'success');
        } catch (error) {
          setStatus(error.message, 'error');
        }
      });

    </script>
  </body>
</html>`;
}

function getPopupPowerShellCommand() {
  return String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$message = $env:POPUP_APP_MESSAGE
$durationMs = [int]$env:POPUP_APP_DURATION_MS
$settings = $env:POPUP_APP_SETTINGS | ConvertFrom-Json
$safeDuration = [Math]::Min([Math]::Max($durationMs, 1500), 30000)
$screenArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea

$backgroundColor = [System.Drawing.ColorTranslator]::FromHtml($settings.backgroundColor)
$accentColor = [System.Drawing.ColorTranslator]::FromHtml($settings.accentColor)
$textColor = [System.Drawing.ColorTranslator]::FromHtml($settings.textColor)
$popupWidth = [int]$settings.width
$popupHeight = [int]$settings.height
$fontSize = [single]$settings.fontSize
$opacity = [double]$settings.opacity / 100

$form = New-Object System.Windows.Forms.Form
$form.Width = $popupWidth
$form.Height = $popupHeight
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(($screenArea.Right - $form.Width - 24), ($screenArea.Top + 24))
$form.FormBorderStyle = 'None'
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = $backgroundColor
$form.Opacity = $opacity

$graphicsPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$graphicsPath.AddArc(0, 0, 28, 28, 180, 90)
$graphicsPath.AddArc(($form.Width - 29), 0, 28, 28, 270, 90)
$graphicsPath.AddArc(($form.Width - 29), ($form.Height - 29), 28, 28, 0, 90)
$graphicsPath.AddArc(0, ($form.Height - 29), 28, 28, 90, 90)
$graphicsPath.CloseFigure()
$form.Region = New-Object System.Drawing.Region($graphicsPath)

$panel = New-Object System.Windows.Forms.Panel
$panel.Dock = 'Fill'
$panel.BackColor = $backgroundColor
$panel.Padding = New-Object System.Windows.Forms.Padding(26, 20, 22, 20)

$accentBar = New-Object System.Windows.Forms.Panel
$accentBar.Width = 10
$accentBar.Dock = 'Left'
$accentBar.BackColor = $accentColor

$shine = New-Object System.Windows.Forms.Panel
$shine.Dock = 'Top'
$shine.Height = 8
$shine.BackColor = [System.Drawing.Color]::FromArgb(45, 255, 255, 255)

$body = New-Object System.Windows.Forms.Label
$body.MaximumSize = New-Object System.Drawing.Size(($popupWidth - 74), 0)
$body.AutoSize = $true
$body.Font = New-Object System.Drawing.Font('Segoe UI Semibold', $fontSize, [System.Drawing.FontStyle]::Bold)
$body.ForeColor = $textColor
$body.Text = $message
$body.Location = New-Object System.Drawing.Point(28, 30)

$panel.Controls.Add($shine)
$panel.Controls.Add($body)
$form.Controls.Add($accentBar)
$form.Controls.Add($panel)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $safeDuration
$timer.Add_Tick({
  $timer.Stop()
  $form.Close()
})

$form.Add_Shown({
  $timer.Start()
})

[void]$form.ShowDialog()`;
}

function showPopup(message, durationMs = DEFAULT_DURATION_MS, settings = popupSettings) {
  if (popupInFlight) {
    return false;
  }

  popupInFlight = true;
  const resolvedSettings = normalizePopupSettings(settings);

  execFile(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      getPopupPowerShellCommand(),
    ],
    {
      env: {
        ...process.env,
        POPUP_APP_MESSAGE: message,
        POPUP_APP_DURATION_MS: String(durationMs),
        POPUP_APP_SETTINGS: JSON.stringify(resolvedSettings),
      },
    },
    (error) => {
      popupInFlight = false;

      if (error) {
        console.error('Falha ao mostrar popup:', error.message);
      }
    }
  );

  return true;
}

const webApp = express();

webApp.use(express.json());
webApp.use(express.urlencoded({ extended: true }));

webApp.get('/', (_request, response) => {
  response.type('html').send(getControlPanelHtml(popupSettings));
});

webApp.get('/api/health', (_request, response) => {
  response.json({ ok: true, host: HOST, port: PORT });
});

webApp.get('/api/settings', (_request, response) => {
  response.json({ ok: true, settings: popupSettings, defaults: defaultPopupSettings });
});

webApp.get('/api/remote-config', (_request, response) => {
  response.json({ ok: true, config: remoteConfig, defaults: defaultRemoteConfig });
});

webApp.post('/api/settings', (request, response) => {
  const savedSettings = savePopupSettings(request.body || {});
  response.json({ ok: true, settings: savedSettings });
});

webApp.post('/api/remote-config', (request, response) => {
  const savedConfig = saveRemoteConfig(request.body || {});
  restartRemotePolling();
  response.json({ ok: true, config: savedConfig });
});

webApp.post('/api/popup', (request, response) => {
  const rawMessage = typeof request.body?.message === 'string' ? request.body.message : '';
  const message = rawMessage.trim();
  const rawDuration = Number(request.body?.durationMs);
  const settings = normalizePopupSettings(request.body?.settings || popupSettings);
  const durationMs = Number.isFinite(rawDuration)
    ? Math.min(Math.max(rawDuration, 1500), 30000)
    : DEFAULT_DURATION_MS;

  if (!message) {
    response.status(400).json({ ok: false, error: 'Envie um texto para o pop-up.' });
    return;
  }

  showPopup(message, durationMs, settings);
  response.json({ ok: true, message, durationMs, settings });
});

const server = webApp.listen(PORT, HOST, () => {
  console.log(`Painel disponivel em http://${HOST}:${PORT}`);

  if (shouldOpenPanelOnLaunch) {
    openControlPanel();
  }

  restartRemotePolling();
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.log(`Aplicativo ja esta em execucao em http://${HOST}:${PORT}`);

    if (shouldOpenPanelOnLaunch) {
      openControlPanel();
    }

    process.exit(0);
  }

  console.error('Falha ao iniciar o servidor:', error.message);
  process.exit(1);
});
