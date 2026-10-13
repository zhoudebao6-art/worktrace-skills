param([Parameter(Mandatory=$true)][string]$Policy,[switch]$Once,[switch]$SelfTest)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
# Only this bridge is background work; never reprioritize the observed app.
try{[Diagnostics.Process]::GetCurrentProcess().PriorityClass=[Diagnostics.ProcessPriorityClass]::BelowNormal}catch{}
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Drawing,System.Windows.Forms
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WorkTraceNative {
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
 public static bool IsEdit(IntPtr h){var s=new StringBuilder(256);GetClassName(h,s,256);return s.ToString().IndexOf("edit",StringComparison.OrdinalIgnoreCase)>=0;}
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
 [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint f, bool inherit, uint access);
 [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref INPUT i);
 public struct INPUT { public uint cbSize; public uint dwTime; }
 public struct RECT {public int Left,Top,Right,Bottom;}
 public static double Idle(){INPUT i=new INPUT();i.cbSize=(uint)Marshal.SizeOf(i);GetLastInputInfo(ref i);return ((uint)Environment.TickCount-i.dwTime)/1000.0;}
}
'@
function Read-Elements($root,$walker,$cache,$timer,[int]$MaxNodes=250,[int]$MaxMilliseconds=1200){
 $texts=[Collections.Generic.List[string]]::new();$unique=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal);$masks=[Collections.Generic.List[object]]::new();$truncated=$false;$seen=0;$enqueued=0;$navigation=0;$peakQueue=0;$textLength=0
 $q=[Collections.Generic.Queue[object]]::new();$q.Enqueue($root);$enqueued=1;$peakQueue=1
 while($q.Count -gt 0){
  if($seen -ge $MaxNodes -or $timer.ElapsedMilliseconds -ge $MaxMilliseconds){$truncated=$true;break}
  $el=$q.Dequeue();$seen++
  try{
   $c=$el.Cached
   if($c.IsPassword -or $c.ControlType.Id -eq [Windows.Automation.ControlType]::Edit.Id -or [WorkTraceNative]::IsEdit([IntPtr]$c.NativeWindowHandle)){$masks.Add($c.BoundingRectangle);continue}
   if(!$c.IsOffscreen -and $c.ControlType -ne [Windows.Automation.ControlType]::Window){
    $v=$el.Current.Name
    if($v -and $unique.Add($v)){$texts.Add($v);$textLength+=$v.Length+1;if($textLength -gt 12000){$truncated=$true;break}}
   }
   if($timer.ElapsedMilliseconds -ge $MaxMilliseconds){$truncated=$true;break}
   if($enqueued -ge $MaxNodes){$truncated=$true;continue}
   $child=$walker.GetFirstChild($el,$cache);$navigation++
   while($child){
    if($enqueued -ge $MaxNodes -or $timer.ElapsedMilliseconds -ge $MaxMilliseconds){$truncated=$true;break}
    $q.Enqueue($child);$enqueued++;$peakQueue=[Math]::Max($peakQueue,$q.Count)
    # The budget applies before every sibling IPC, not only to dequeued nodes.
    if($enqueued -ge $MaxNodes -or $timer.ElapsedMilliseconds -ge $MaxMilliseconds){$truncated=$true;break}
    $child=$walker.GetNextSibling($child,$cache);$navigation++
   }
  }catch{$truncated=$true}
 }
 $text=($texts -join "`n");if($text.Length -gt 12000){$text=$text.Substring(0,12000);$truncated=$true}
 return @{text=$text;truncated=$truncated;masks=$masks;visited=$seen;enqueued=$enqueued;navigation_calls=$navigation;peak_queue=$peakQueue;elapsed_ms=$timer.ElapsedMilliseconds}
}
function Read-Window([IntPtr]$handle,[int]$MaxNodes=250,[int]$MaxMilliseconds=1200){
 $timer=[Diagnostics.Stopwatch]::StartNew()
 if([WorkTraceNative]::IsEdit($handle)){
  $bounds=[WorkTraceNative+RECT]::new();[void][WorkTraceNative]::GetWindowRect($handle,[ref]$bounds);$masks=[Collections.Generic.List[object]]::new()
  $masks.Add([Windows.Rect]::new($bounds.Left,$bounds.Top,[Math]::Max(0,$bounds.Right-$bounds.Left),[Math]::Max(0,$bounds.Bottom-$bounds.Top)))
  return @{text='';truncated=$false;masks=$masks;visited=1;enqueued=1;navigation_calls=0;peak_queue=1;elapsed_ms=$timer.ElapsedMilliseconds}
 }
 # Fetch classification/bounds in one UIA cache request. Never prefetch Name or
 # Value from password/edit controls; readable names are requested only after
 # the same privacy checks used for the original traversal.
 $cache=[Windows.Automation.CacheRequest]::new();$cache.TreeScope=[Windows.Automation.TreeScope]::Element
 foreach($property in @([Windows.Automation.AutomationElement]::IsPasswordProperty,[Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.AutomationElement]::NativeWindowHandleProperty,[Windows.Automation.AutomationElement]::BoundingRectangleProperty,[Windows.Automation.AutomationElement]::IsOffscreenProperty)){$cache.Add($property)}
 $root=[Windows.Automation.AutomationElement]::FromHandle($handle).GetUpdatedCache($cache)
 return Read-Elements $root ([Windows.Automation.TreeWalker]::ControlViewWalker) $cache $timer $MaxNodes $MaxMilliseconds
}
function Test-CaptureSize([int]$Width,[int]$Height){return $Width -gt 0 -and $Height -gt 0 -and $Width -le 5000 -and $Height -le 5000 -and ([long]$Width*$Height) -le 10000000}
if($SelfTest){
 $form=[Windows.Forms.Form]::new();$form.Text='WorkTrace fixture'
 $label=[Windows.Forms.Label]::new();$label.Text='fixture-visible-text';$label.AccessibleName='fixture-visible-text';$label.Width=200;$form.Controls.Add($label)
 $secret=[Windows.Forms.TextBox]::new();$secret.UseSystemPasswordChar=$true;$secret.Text='fixture-secret-never-collect';$secret.Top=40;$form.Controls.Add($secret)
 $null=$form.Handle;$null=$label.Handle;$null=$secret.Handle
 $r=Read-Window $form.Handle
 $labelEl=[Windows.Automation.AutomationElement]::FromHandle($label.Handle)
 $secretEl=[Windows.Automation.AutomationElement]::FromHandle($secret.Handle)
 $passwordRead=Read-Window $secret.Handle
 $passed=(!$passwordRead.text.Contains($secret.Text)) -and ($passwordRead.masks.Count -gt 0) -and ($labelEl.Current.Name -eq 'fixture-visible-text')
 # Exercise the actual bounded traversal against a synthetic 400-wide tree,
 # without showing a window, obtaining foreground handles or capturing pixels.
 $nodes=@();for($i=0;$i -le 400;$i++){$nodes+=[PSCustomObject]@{Index=$i;Cached=[PSCustomObject]@{IsPassword=$false;ControlType=[Windows.Automation.ControlType]::Text;NativeWindowHandle=0;BoundingRectangle=[Windows.Rect]::Empty;IsOffscreen=$false};Current=[PSCustomObject]@{Name='synthetic-node-'+$i}}}
 $walker=[PSCustomObject]@{Nodes=$nodes;Slow=$false;Calls=0}
 $walker|Add-Member ScriptMethod GetFirstChild {param($node,$cache)$this.Calls++;if($this.Slow){Start-Sleep -Milliseconds 10};if($node.Index -eq 0){return $this.Nodes[1]};return $null}
 $walker|Add-Member ScriptMethod GetNextSibling {param($node,$cache)$this.Calls++;if($this.Slow){Start-Sleep -Milliseconds 10};if($node.Index -lt 400){return $this.Nodes[$node.Index+1]};return $null}
 $bounded=Read-Elements $nodes[0] $walker $null ([Diagnostics.Stopwatch]::StartNew()) 40 1200
 $walker.Slow=$true;$timed=Read-Elements $nodes[0] $walker $null ([Diagnostics.Stopwatch]::StartNew()) 250 30
 $passed=$passed -and $bounded.enqueued -eq 40 -and $bounded.visited -eq 40 -and $bounded.navigation_calls -le 80 -and $bounded.truncated -and $timed.truncated -and $timed.navigation_calls -lt 20 -and !(Test-CaptureSize 5000 5000) -and (Test-CaptureSize 3840 2160)
 @{type='selftest';passed=$passed;password_not_collected=(!$passwordRead.text.Contains($secret.Text));password_control_skipped=($passwordRead.masks.Count -gt 0);visited=$r.visited;hidden_control_name=$labelEl.Current.Name;wide_visited=$bounded.visited;wide_enqueued=$bounded.enqueued;wide_navigation_calls=$bounded.navigation_calls;wide_peak_queue=$bounded.peak_queue;wide_truncated=$bounded.truncated;wide_elapsed_ms=$bounded.elapsed_ms;timed_navigation_calls=$timed.navigation_calls;timed_truncated=$timed.truncated;max_bitmap_pixels=10000000;priority=[Diagnostics.Process]::GetCurrentProcess().PriorityClass.ToString()} | ConvertTo-Json -Compress
 $form.Dispose();if(!$passed){exit 1};exit 0
}
$cfg=Get-Content -LiteralPath $Policy -Raw -Encoding UTF8 | ConvertFrom-Json
do{
 try{
  $capture=@{process_name='';window_title='';text='';capture_status='activity_only';idle_seconds=[WorkTraceNative]::Idle();truncated=$false;reason='';image=$null}
  $desk=[WorkTraceNative]::OpenInputDesktop(0,$false,0x0100)
  if($desk -eq [IntPtr]::Zero){$capture.capture_status='locked';$capture.reason='desktop-unavailable'}
  else{
   [void][WorkTraceNative]::CloseDesktop($desk)
   $h=[WorkTraceNative]::GetForegroundWindow();$procId=[uint32]0;[void][WorkTraceNative]::GetWindowThreadProcessId($h,[ref]$procId)
   $p=Get-Process -Id $procId -ErrorAction SilentlyContinue
   if(!$p){$capture.capture_status='unavailable';$capture.reason='foreground-unavailable'}
   else{
    $name=$p.ProcessName.ToLowerInvariant()+'.exe'
    $title=[Text.StringBuilder]::new(1024);[void][WorkTraceNative]::GetWindowText($h,$title,1024)
    $blocked=$cfg.excluded_processes -contains $name
    foreach($word in $cfg.excluded_title_terms){if($word -and $title.ToString().IndexOf($word,[StringComparison]::OrdinalIgnoreCase) -ge 0){$blocked=$true}}
    if($blocked){$capture.capture_status='excluded';$capture.reason='excluded-by-policy'}
    elseif($capture.idle_seconds -ge $cfg.idle_seconds){$capture.capture_status='idle';$capture.reason='idle-threshold'}
    else{
     $capture.process_name=$name
     $deep=$cfg.content_processes -contains $name
     if($deep -or $cfg.record_titles){$capture.window_title=$title.ToString().Substring(0,[Math]::Min(500,$title.Length))}
     if($deep){
      try{
       $r=Read-Window $h;$capture.text=$r.text;$capture.truncated=$r.truncated;$capture.capture_status='uia'
       if($r.truncated){$capture.reason='uia-incomplete-budget-or-provider'}
       if(!$r.text){$capture.capture_status='unavailable';$capture.reason='uia-no-readable-text'}
       if($cfg.screenshots -and !$r.truncated -and $r.visited -gt 1){
        $rect=[WorkTraceNative+RECT]::new();[void][WorkTraceNative]::GetWindowRect($h,[ref]$rect)
        $w=$rect.Right-$rect.Left;$height=$rect.Bottom-$rect.Top
        if(Test-CaptureSize $w $height){
         $bmp=[Drawing.Bitmap]::new($w,$height);$g=[Drawing.Graphics]::FromImage($bmp)
         try{$dc=$g.GetHdc();try{$ok=[WorkTraceNative]::PrintWindow($h,$dc,2)}finally{$g.ReleaseHdc($dc)}
          if($ok){
           foreach($mask in $r.masks){if(!$mask.IsEmpty){$g.FillRectangle([Drawing.Brushes]::Black,[int]($mask.X-$rect.Left),[int]($mask.Y-$rect.Top),[int]$mask.Width,[int]$mask.Height)}}
           $scale=[Math]::Min(1,1600.0/[Math]::Max($w,$height));$thumb=[Drawing.Bitmap]::new($bmp,[int]($w*$scale),[int]($height*$scale));$ms=[IO.MemoryStream]::new()
           try{$thumb.Save($ms,[Drawing.Imaging.ImageFormat]::Jpeg);if($ms.Length -le 2097152){$capture.image=[Convert]::ToBase64String($ms.ToArray())}}finally{$ms.Dispose();$thumb.Dispose()}
          }
         }finally{$g.Dispose();$bmp.Dispose()}
        }else{$capture.reason='screenshot-pixel-budget';$capture.truncated=$true}
       }
      }catch{$capture.capture_status='unavailable';$capture.reason='uia-read-failed'}
     }
    }
   }
  }
  $capture | ConvertTo-Json -Compress -Depth 6 | Write-Output
 }catch{@{capture_status='unavailable';reason='observer-error';process_name='';window_title='';text='';idle_seconds=0;truncated=$false;image=$null}|ConvertTo-Json -Compress|Write-Output}
 if(!$Once){Start-Sleep -Seconds $cfg.interval_seconds}
}while(!$Once)
