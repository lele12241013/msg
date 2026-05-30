Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

projectFolder = fileSystem.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = projectFolder
shell.Run Chr(34) & projectFolder & "\Instalar Popup Remoto.cmd" & Chr(34), 0, False
