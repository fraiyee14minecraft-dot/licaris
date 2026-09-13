using System;
using System.Diagnostics;
using System.IO;
class Publisher {
 static int Main(string[] args) {
  string root=AppDomain.CurrentDomain.BaseDirectory;
  Console.Title="Licaris - Publication GitHub";
  Console.WriteLine("LICARIS - PUBLICATION GITHUB\n");
  var p=new ProcessStartInfo();p.WorkingDirectory=root;p.UseShellExecute=false;
#if LAUNCHER
  p.FileName="cmd.exe";p.Arguments="/d /c npm run publish:launcher";
#else
  p.FileName="node.exe";p.Arguments="\""+Path.Combine(root,"scripts","publish-modpack.mjs")+"\"";
  if(Array.IndexOf(args,"--dry-run")>=0)p.Arguments+=" --dry-run";
#endif
  try {using(var child=Process.Start(p)){child.WaitForExit();Console.WriteLine(child.ExitCode==0?"\nTermine. Appuyez sur une touche pour fermer.":"\nPublication interrompue. Consultez le message ci-dessus.");if(!Console.IsInputRedirected)Console.ReadKey(true);return child.ExitCode;}}
  catch(Exception e){Console.WriteLine(e.Message+"\nNode.js et Git doivent etre installes sur le PC de publication.");if(!Console.IsInputRedirected)Console.ReadKey(true);return 1;}
 }
}
