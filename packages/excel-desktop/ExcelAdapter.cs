using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using NativeUia;

// Independent product adapter using the OS UIA3 COM API, not a Codex helper.
// Only semantic Copilot operations in one selected EXCEL.EXE window are exposed.
class ExcelAdapter {
  delegate bool EnumWindow(IntPtr hwnd,IntPtr param);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback,IntPtr param);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd,StringBuilder text,int size);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd,uint flag);
  static bool ExcelForeground(){var fg=GetForegroundWindow();return fg==selected||GetAncestor(fg,2)==selected||GetAncestor(fg,3)==selected;}
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from,uint to,bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  static bool Foreground(IntPtr hwnd){if(GetForegroundWindow()==hwnd)return true;if(SetForegroundWindow(hwnd)&&GetForegroundWindow()==hwnd)return true;uint pid;uint other=GetWindowThreadProcessId(GetForegroundWindow(),out pid),mine=GetCurrentThreadId();if(other==0||other==mine)return false;bool attached=AttachThreadInput(mine,other,true);try{SetForegroundWindow(hwnd);return GetForegroundWindow()==hwnd;}finally{if(attached)AttachThreadInput(mine,other,false);}}
  [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,INPUT[] inputs,int size);
  [StructLayout(LayoutKind.Explicit,Size=40)] struct INPUT {
    [FieldOffset(0)] public uint type;[FieldOffset(8)] public ushort vk;[FieldOffset(10)] public ushort scan;[FieldOffset(12)] public uint flags;
  }
  static INPUT Key(ushort vk,ushort scan,uint flags){return new INPUT{type=1,vk=vk,scan=scan,flags=flags};}
  static string Normalize(string value){return (value??"").Replace("\r\n","\n").TrimEnd('\n');}
  static bool ChatMode(string name){return name.StartsWith("Switch mode, current: Chat,")||name.StartsWith("Switch mode, current: Chat only,");}
  static void FocusedInput(E input){var focus=uia.GetFocusedElement();uint pid;GetWindowThreadProcessId(GetForegroundWindow(),out pid);if(focus==null||uia.CompareElements(input.raw,focus)==0||(pid!=selectedPid&&pid!=focus.CurrentProcessId))throw new Exception("Excel chat focus changed; stopped before sending");}
  static void TypePrompt(E input,string prompt) {
    input.raw.SetFocus();Thread.Sleep(100);var focus=uia.GetFocusedElement();if(focus==null||uia.CompareElements(input.raw,focus)==0){if(!Foreground(selected))throw new Exception("Excel could not receive foreground input");input.raw.SetFocus();Thread.Sleep(100);}FocusedInput(input);
    var batch=new List<INPUT>();
    Action flush=()=>{if(batch.Count==0)return;FocusedInput(input);var items=batch.ToArray();if(SendInput((uint)items.Length,items,40)!=items.Length)throw new Exception("Incomplete keyboard input; message not sent");batch.Clear();Thread.Sleep(12);};
    foreach(char ch in prompt.Replace("\r\n","\n")) {
      if(ch=='\n'){flush();batch.Add(Key(0x10,0,0));batch.Add(Key(0x0D,0,0));batch.Add(Key(0x0D,0,2));batch.Add(Key(0x10,0,2));flush();}
      else{batch.Add(Key(0,(ushort)ch,4));batch.Add(Key(0,(ushort)ch,6));if(batch.Count>=128)flush();}
    }flush();
  }
  static JavaScriptSerializer json=new JavaScriptSerializer { MaxJsonLength=2000000 };
  static IUIAutomation uia=new CUIAutomation8Class();
  static IntPtr selected; static int selectedPid; static long started;
  class E {
    public IUIAutomationElement raw;
    public E(IUIAutomationElement raw){this.raw=raw;}
    public string Name {get{return raw.CurrentName??"";}}
    public string Id {get{return raw.CurrentAutomationId??"";}}
    public int Type {get{return raw.CurrentControlType;}}
    public bool Enabled {get{return raw.CurrentIsEnabled!=0;}}
    public bool Offscreen {get{return raw.CurrentIsOffscreen!=0;}}
    public object Pattern(int id){try{return raw.GetCurrentPattern(id);}catch(COMException){return null;}}
    public string Value {get{var v=Pattern(10002) as IUIAutomationValuePattern;return v==null?null:v.CurrentValue;}}
  }
  static bool IsExcel(IntPtr hwnd,out Process process) {
    process=null;var cls=new StringBuilder(256);GetClassName(hwnd,cls,256);if(cls.ToString()!="XLMAIN"||!IsWindowVisible(hwnd))return false;
    uint pid;GetWindowThreadProcessId(hwnd,out pid);try{process=Process.GetProcessById((int)pid);return String.Equals(System.IO.Path.GetFileName(process.MainModule.FileName),"EXCEL.EXE",StringComparison.OrdinalIgnoreCase);}catch{return false;}
  }
  static E Document() {
    Process p;if(!IsExcel(selected,out p)||p.Id!=selectedPid||p.StartTime.ToUniversalTime().Ticks!=started)throw new Exception("Selected Excel process/window changed; select it again");
    var window=uia.ElementFromHandle(selected);
    var condition=uia.CreateAndCondition(uia.CreatePropertyCondition(30003,50030),uia.CreatePropertyCondition(30005,"Excel Copilot Chat Add-in"));
    var docs=window.FindAll(TreeScope.TreeScope_Descendants,condition);
    if(docs.Length!=1)throw new Exception("Open Copilot in the selected Excel window; one Copilot document is required");return new E(docs.GetElement(0));
  }
  static List<E> Elements(E root) {
    var all=root.raw.FindAll(TreeScope.TreeScope_Descendants,uia.CreateTrueCondition());var list=new List<E>();
    if(all.Length>1500)throw new Exception("Copilot accessibility tree exceeds limit");for(int i=0;i<all.Length;i++)list.Add(new E(all.GetElement(i)));return list;
  }
  static void Walk(E e,int depth,List<object> rows) {
    if(depth>35||rows.Count>=1500)throw new Exception("Copilot tree exceeds limit");
    rows.Add(new {name=e.Name,id=e.Id,type=e.Type,enabled=e.Enabled,offscreen=e.Offscreen,depth=depth,value=e.Name=="Chat input"?e.Value:null});var walker=uia.ControlViewWalker;
    for(var child=walker.GetFirstChildElement(e.raw);child!=null;child=walker.GetNextSiblingElement(child))Walk(new E(child),depth+1,rows);
  }
  static object Snapshot(){var rows=new List<object>();Walk(Document(),0,rows);return new {window=selected.ToInt64(),pid=selectedPid,nodes=rows};}
  static void Invoke(E e) {
    if(!e.Enabled)throw new Exception("Copilot control disabled");var inv=e.Pattern(10000) as IUIAutomationInvokePattern;if(inv!=null){inv.Invoke();return;}
    var sel=e.Pattern(10010) as IUIAutomationSelectionItemPattern;if(sel!=null){sel.Select();return;}
    var exp=e.Pattern(10005) as IUIAutomationExpandCollapsePattern;if(exp!=null){exp.Expand();return;}
    throw new Exception("Copilot control has no supported action pattern");
  }
  static E Unique(Func<E,bool> predicate){var found=Elements(Document()).Where(predicate).ToList();if(found.Count!=1)throw new Exception("Expected exactly one Copilot control, found "+found.Count);return found[0];}
  static E Wait(Func<E,bool> predicate){for(int n=0;n<25;n++){var found=Elements(Document()).Where(predicate).ToList();if(found.Count==1)return found[0];if(found.Count>1)throw new Exception("Ambiguous Copilot control");Thread.Sleep(200);}throw new Exception("Required Copilot control did not appear");}
  static bool Named(E e,string name){return e.Name==name&&!e.Offscreen;}
  static object Handle(Dictionary<string,object> request) {
    var op=(string)request["op"];
    if(op=="snapshot")return Snapshot();
    if(op=="chat-only") {
      var mode=Unique(e=>e.Name.StartsWith("Switch mode, current:")&&e.Type==50000);
      if(!ChatMode(mode.Name)){Invoke(mode);Invoke(Wait(e=>Named(e,"Chat only")&&(e.Type==50011||e.Type==50013)));Wait(e=>e.Type==50000&&ChatMode(e.Name));}return new {ok=true};
    }
    if(op=="new-chat"){Invoke(Unique(e=>Named(e,"New chat")&&e.Type==50000));return new {ok=true};}
    if(op=="model"){
      var desired=(string)request["label"];if(desired!="Claude Opus 5.5"&&desired!="Claude Sonnet 5.5")throw new Exception("Unsupported model");
      var picker=Unique(e=>e.Name.StartsWith("Select model ")&&e.Type==50000);
      if(picker.Name!="Select model "+desired){
        if(!Elements(Document()).Any(e=>e.Type==50009&&!e.Offscreen))Invoke(picker);
        Invoke(Wait(e=>e.Name.StartsWith("Claude ")&&e.Name.Contains("Anthropic")&&e.Type==50011&&!e.Offscreen));
        Invoke(Wait(e=>e.Name.StartsWith(desired)&&!e.Name.Contains("Anthropic")&&(e.Type==50011||e.Type==50013)&&!e.Offscreen));
        Wait(e=>e.Name=="Select model "+desired&&e.Type==50000);
      }return new {ok=true};
    }
    if(op=="send") {
      var mode=Unique(e=>e.Name.StartsWith("Switch mode, current:")&&e.Type==50000);if(!ChatMode(mode.Name))throw new Exception("Chat only must be verified before sending");
      var input=Unique(e=>Named(e,"Chat input")&&e.Type==50003);var prompt=(string)request["text"];
      if(prompt.Length==0||prompt.Length>64000)throw new Exception("Desktop prompt limit is 64000 characters");if(!input.Enabled||Elements(Document()).Any(e=>e.Name=="Stop generating"&&e.Type==50000))throw new Exception("Copilot is busy; no input");if(!String.IsNullOrWhiteSpace(input.Value))throw new Exception("User draft present; no overwrite");
      var previous=GetForegroundWindow();try {
        var value=input.Pattern(10002) as IUIAutomationValuePattern;if(value==null)throw new Exception("Copilot input has no ValuePattern");value.SetValue(prompt);Thread.Sleep(200);
        if(Normalize(input.Value)!=Normalize(prompt)) {
          if(!String.IsNullOrWhiteSpace(input.Value))throw new Exception("Partial value input; message not sent");TypePrompt(input,prompt);
        }
        for(int n=0;n<30&&Normalize(input.Value)!=Normalize(prompt);n++)Thread.Sleep(100);
        if(Normalize(input.Value)!=Normalize(prompt))throw new Exception("Input readback mismatch; message not sent");
        var send=Wait(e=>e.Name.StartsWith("Send")&&e.Type==50000&&e.Enabled&&!e.Offscreen);
        if(!ChatMode(Unique(e=>e.Name.StartsWith("Switch mode, current:")&&e.Type==50000).Name)||Normalize(input.Value)!=Normalize(prompt))throw new Exception("Chat mode/input changed before submit; message not sent");
        Invoke(send);return new {submitted=true};
      } finally {var focus=uia.GetFocusedElement();if(previous!=GetForegroundWindow()&&previous!=IntPtr.Zero&&(ExcelForeground()||(focus!=null&&uia.CompareElements(input.raw,focus)!=0)))Foreground(previous);}
    }
    if(op=="cancel"){var stop=Elements(Document()).Where(e=>Named(e,"Stop generating")&&e.Type==50000).ToList();if(stop.Count==1)Invoke(stop[0]);return new {ok=true};}
    throw new Exception("Unsupported operation");
  }
  [MTAThread] static int Main(string[] args) {
    Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
    if(args.Length==1&&args[0]=="--list"){var windows=new List<object>();EnumWindows((h,p)=>{Process process;if(IsExcel(h,out process)){var e=uia.ElementFromHandle(h);if(!String.IsNullOrEmpty(e.CurrentName))windows.Add(new {window=h.ToInt64(),pid=process.Id,title=e.CurrentName});}return true;},IntPtr.Zero);Console.WriteLine(json.Serialize(windows));return 0;}
    long handle;if(args.Length!=2||args[0]!="--window"||!long.TryParse(args[1],out handle))return 2;selected=new IntPtr(handle);Process excel;if(!IsExcel(selected,out excel))return 3;selectedPid=excel.Id;started=excel.StartTime.ToUniversalTime().Ticks;
    for(string line;(line=Console.ReadLine())!=null;){try{var request=json.Deserialize<Dictionary<string,object>>(line);Console.WriteLine(json.Serialize(new {ok=true,result=Handle(request)}));}catch(Exception error){Console.WriteLine(json.Serialize(new {ok=false,error=error.Message}));}}return 0;
  }
}
