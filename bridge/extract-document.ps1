param([Parameter(Mandatory=$true)][string]$InputFile,[Parameter(Mandatory=$true)][ValidateSet('.docx','.xlsx')][string]$Extension)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[IO.Compression.ZipFile]::OpenRead($InputFile)
$parts=[Collections.Generic.List[string]]::new();$total=0L
function Read-SafeXml($Entry){
 if($Entry.Length -gt 20971520){throw 'XML part exceeds 20MiB'}
 $script:total+=$Entry.Length;if($script:total -gt 41943040){throw 'XML total exceeds 40MiB'}
 $settings=[Xml.XmlReaderSettings]::new();$settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit;$settings.XmlResolver=$null;$settings.MaxCharactersInDocument=20971520
 $stream=$Entry.Open();$reader=[Xml.XmlReader]::Create($stream,$settings)
 try{$doc=[Xml.XmlDocument]::new();$doc.XmlResolver=$null;$doc.Load($reader);return ,$doc}finally{$reader.Dispose();$stream.Dispose()}
}
try{
 if($archive.Entries.Count -gt 10000){throw 'Too many entries'}
 if($Extension -eq '.docx'){
  $entry=$archive.GetEntry('word/document.xml');if(!$entry){throw 'Missing document.xml'};$doc=Read-SafeXml $entry
  foreach($p in $doc.SelectNodes('//*[local-name()="p"]')){ $line=[Text.StringBuilder]::new();foreach($t in $p.SelectNodes('.//*[local-name()="t" or local-name()="delText" or local-name()="tab" or local-name()="br"]')){if($t.LocalName -eq 'tab'){$null=$line.Append("`t")}elseif($t.LocalName -eq 'br'){$null=$line.Append("`n")}else{$null=$line.Append($t.InnerText)}};$parts.Add($line.ToString()) }
  $gaps=@('仅提取正文段落和表格内文字；未解释批注、修订取舍、公式对象、图像、化学结构或版式。删除修订文字也可能出现，须回到原件核验。')
 }else{
  $shared=[Collections.Generic.List[string]]::new();$entry=$archive.GetEntry('xl/sharedStrings.xml');if($entry){$doc=Read-SafeXml $entry;foreach($si in $doc.SelectNodes('//*[local-name()="si"]')){$shared.Add(($si.SelectNodes('.//*[local-name()="t"]')|ForEach-Object {$_.InnerText}) -join '')}}
  foreach($entry in @($archive.Entries|Where-Object {$_.FullName -match '^xl/worksheets/sheet\d+\.xml$'}|Sort-Object FullName)){$doc=Read-SafeXml $entry;$parts.Add('['+$entry.FullName+']');foreach($cell in $doc.SelectNodes('//*[local-name()="c"]')){$v=$cell.SelectSingleNode('./*[local-name()="v"]');$value=if($v){$v.InnerText}else{($cell.SelectNodes('.//*[local-name()="t"]')|ForEach-Object {$_.InnerText}) -join ''};if($cell.GetAttribute('t') -eq 's' -and $value -match '^\d+$'){$index=[int]$value;if($index -ge $shared.Count){throw 'Shared string index invalid'};$value=$shared[$index]};$formula=$cell.SelectSingleNode('./*[local-name()="f"]');if($formula){$value='formula='+$formula.InnerText+'; cached='+$value};$parts.Add($cell.GetAttribute('r')+'='+$value)}}
  $gaps=@('仅保留工作表文件名、单元格坐标、原始值和公式缓存；不计算公式，不解释日期格式、显示单位、图表、合并布局或图片。')
 }
 $text=$parts -join "`n";if($text.Length -gt 60000){$text=$text.Substring(0,60000);$gaps+= '文本超过 60000 字符，尾部未进入提取结果。'}
 @{text=$text;gaps=$gaps}|ConvertTo-Json -Depth 4 -Compress
}finally{$archive.Dispose()}
