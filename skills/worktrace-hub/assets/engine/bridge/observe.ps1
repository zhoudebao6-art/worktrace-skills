param([Parameter(Mandatory=$true)][string]$Policy,[switch]$Once,[switch]$SelfTest)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
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
function Read-Window([IntPtr]$handle){
 $texts=[Collections.Generic.List[string]]::new();$masks=[Collections.Generic.List[object]]::new();$truncated=$false;$seen=0
 if([WorkTraceNative]::IsEdit($handle)){
  $bounds=[WorkTraceNative+RECT]::new();[void][WorkTraceNative]::GetWindowRect($handle,[ref]$bounds)
  $masks.Add([Windows.Rect]::new($bounds.Left,$bounds.Top,[Math]::Max(0,$bounds.Right-$bounds.Left),[Math]::Max(0,$bounds.Bottom-$bounds.Top)))
  return @{text='';truncated=$false;masks=$masks;visited=1}
 }
 $root=[Windows.Automation.AutomationElement]::FromHandle($handle)
 $walker=[Windows.Automation.TreeWalker]::ControlViewWalker
 $q=[Collections.Generic.Queue[Windows.Automation.AutomationElement]]::new();$q.Enqueue($root)
 $timer=[Diagnostics.Stopwatch]::StartNew()
 while($q.Count -gt 0){
  if($seen -ge 250 -or $timer.ElapsedMilliseconds -gt 1200){$truncated=$true;break}
  $el=$q.Dequeue();$seen++
  try{
   $c=$el.Current
   if($c.IsPassword -or $c.ControlType.Id -eq [Windows.Automation.ControlType]::Edit.Id -or [WorkTraceNative]::IsEdit([IntPtr]$c.NativeWindowHandle)){$masks.Add($c.BoundingRectangle);continue}
   if(!$c.IsOffscreen -and $c.ControlType -ne [Windows.Automation.ControlType]::Window){
    $v=$c.Name
    if($v -and !$texts.Contains($v)){$texts.Add($v)}
   }
   $child=$walker.GetFirstChild($el);$n=0
   while($child -and $n -lt 250){$q.Enqueue($child);$child=$walker.GetNextSibling($child);$n++}
  }catch{$truncated=$true}
 }
 $text=($texts -join "`n");if($text.Length -gt 12000){$text=$text.Substring(0,12000);$truncated=$true}
 return @{text=$text;truncated=$truncated;masks=$masks;visited=$seen}
}
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
 @{type='selftest';passed=$passed;password_not_collected=(!$passwordRead.text.Contains($secret.Text));password_control_skipped=($passwordRead.masks.Count -gt 0);visited=$r.visited;hidden_control_name=$labelEl.Current.Name} | ConvertTo-Json -Compress
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
       if(!$r.text){$capture.capture_status='unavailable';$capture.reason='uia-no-readable-text'}
       if($cfg.screenshots -and !$r.truncated -and $r.visited -gt 1){
        $rect=[WorkTraceNative+RECT]::new();[void][WorkTraceNative]::GetWindowRect($h,[ref]$rect)
        $w=$rect.Right-$rect.Left;$height=$rect.Bottom-$rect.Top
        if($w -gt 0 -and $height -gt 0 -and $w -le 5000 -and $height -le 5000){
         $bmp=[Drawing.Bitmap]::new($w,$height);$g=[Drawing.Graphics]::FromImage($bmp)
         try{$dc=$g.GetHdc();try{$ok=[WorkTraceNative]::PrintWindow($h,$dc,2)}finally{$g.ReleaseHdc($dc)}
          if($ok){
           foreach($mask in $r.masks){if(!$mask.IsEmpty){$g.FillRectangle([Drawing.Brushes]::Black,[int]($mask.X-$rect.Left),[int]($mask.Y-$rect.Top),[int]$mask.Width,[int]$mask.Height)}}
           $scale=[Math]::Min(1,1600.0/[Math]::Max($w,$height));$thumb=[Drawing.Bitmap]::new($bmp,[int]($w*$scale),[int]($height*$scale));$ms=[IO.MemoryStream]::new()
           try{$thumb.Save($ms,[Drawing.Imaging.ImageFormat]::Jpeg);if($ms.Length -le 2097152){$capture.image=[Convert]::ToBase64String($ms.ToArray())}}finally{$ms.Dispose();$thumb.Dispose()}
          }
         }finally{$g.Dispose();$bmp.Dispose()}
        }
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
