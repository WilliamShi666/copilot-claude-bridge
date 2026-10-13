using System;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.InteropServices;
class ImportUia : ITypeLibImporterNotifySink {
 [DllImport("oleaut32.dll",CharSet=CharSet.Unicode,PreserveSig=false)] static extern void LoadTypeLibEx(string file,int kind,[MarshalAs(UnmanagedType.Interface)]out object library);
 public void ReportEvent(ImporterEventKind kind,int code,string message) {}
 public Assembly ResolveRef(object library){throw new Exception("Unexpected external type library");}
 static void Main(string[] args){object library;LoadTypeLibEx(Environment.SystemDirectory+"\\UIAutomationCore.dll",2,out library);var assembly=new TypeLibConverter().ConvertTypeLibToAssembly(library,args[0],TypeLibImporterFlags.None,new ImportUia(),null,null,"NativeUia",null);assembly.Save(System.IO.Path.GetFileName(args[0]));}
}
