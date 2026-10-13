param([Parameter(Mandatory=$true)][string]$InputFile,[Parameter(Mandatory=$true)][ValidateSet('.docx','.xlsx')][string]$Extension)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[IO.Compression.ZipFile]::OpenRead($InputFile)
$text=[Text.StringBuilder]::new();$total=0L;$clipped=$false;$hasLine=$false
function Open-SafeXml($Entry){
 if($Entry.Length -gt 20971520){throw 'XML part exceeds 20MiB'}
 $script:total+=$Entry.Length;if($script:total -gt 41943040){throw 'XML total exceeds 40MiB'}
 $settings=[Xml.XmlReaderSettings]::new();$settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit;$settings.XmlResolver=$null;$settings.MaxCharactersInDocument=20971520;$settings.CloseInput=$true
 $stream=$Entry.Open();try{return [Xml.XmlReader]::Create($stream,$settings)}catch{$stream.Dispose();throw}
}
function Add-Text([string]$Value){
 $remaining=60000-$script:text.Length
 if($Value.Length -gt $remaining){$null=$script:text.Append($Value,0,$remaining);$script:clipped=$true}else{$null=$script:text.Append($Value)}
}
function Add-Line([string]$Value){if($script:hasLine){Add-Text "`n"};$script:hasLine=$true;Add-Text $Value}
# Keep text bounded without loading the complete XML into a DOM.
function Read-ElementText($Reader,[int]$Limit=60001){
 $part=$Reader.ReadSubtree();$value=[Text.StringBuilder]::new();$buffer=New-Object char[] 1024;$truncated=$false
 try{while($part.Read()){
  if($part.NodeType -notin @([Xml.XmlNodeType]::Text,[Xml.XmlNodeType]::CDATA,[Xml.XmlNodeType]::Whitespace,[Xml.XmlNodeType]::SignificantWhitespace)){continue}
  do{$count=$part.ReadValueChunk($buffer,0,[Math]::Min($buffer.Length,$Limit-$value.Length));if($count){$null=$value.Append($buffer,0,$count)}}while($count -and $value.Length -lt $Limit)
  if($value.Length -ge $Limit){$truncated=$true;break}
 }}finally{$part.Dispose()}
 return @{text=$value.ToString();truncated=$truncated}
}
function Read-Cell($Reader){
 $part=$Reader.ReadSubtree();$value='';$formula=$null;$inline=[Text.StringBuilder]::new();$truncated=$false
 try{while($part.Read()){
  if($part.NodeType -ne [Xml.XmlNodeType]::Element -or $part.LocalName -notin @('v','f','t')){continue}
  $name=$part.LocalName;$piece=Read-ElementText $part;$truncated=$truncated -or $piece.truncated
  if($name -eq 'v'){$value=$piece.text}elseif($name -eq 'f'){$formula=$piece.text}else{$remaining=60001-$inline.Length;if($piece.text.Length -gt $remaining){$null=$inline.Append($piece.text,0,$remaining);$truncated=$true}else{$null=$inline.Append($piece.text)}}
 }}finally{$part.Dispose()}
 if(!$value){$value=$inline.ToString()};return @{value=$value;formula=$formula;truncated=$truncated}
}
function Read-SharedString($Reader){
 $part=$Reader.ReadSubtree();$value=[Text.StringBuilder]::new()
 try{while($part.Read()){
  if($part.NodeType -eq [Xml.XmlNodeType]::Element -and $part.LocalName -eq 't'){$piece=Read-ElementText $part ([Math]::Max(1,60001-$value.Length));$remaining=60001-$value.Length;$null=$value.Append($piece.text,0,[Math]::Min($remaining,$piece.text.Length));if($value.Length -ge 60001){break}}
 }}finally{$part.Dispose()}
 return $value.ToString()
}
try{
 if($archive.Entries.Count -gt 10000){throw 'Too many entries'}
 if($Extension -eq '.docx'){
  $entry=$archive.GetEntry('word/document.xml');if(!$entry){throw 'Missing document.xml'};$reader=Open-SafeXml $entry;$paragraphDepth=0
  try{while($reader.Read()){
   if($reader.NodeType -eq [Xml.XmlNodeType]::Element){
    if($reader.LocalName -eq 'p'){Add-Line '';if(!$reader.IsEmptyElement){$paragraphDepth++}}
    elseif($paragraphDepth -gt 0 -and $reader.LocalName -in @('t','delText')){$piece=Read-ElementText $reader ([Math]::Max(1,60001-$text.Length));Add-Text $piece.text;if($piece.truncated){$clipped=$true}}
    elseif($paragraphDepth -gt 0 -and $reader.LocalName -eq 'tab'){Add-Text "`t"}
    elseif($paragraphDepth -gt 0 -and $reader.LocalName -eq 'br'){Add-Text "`n"}
   }elseif($reader.NodeType -eq [Xml.XmlNodeType]::EndElement -and $reader.LocalName -eq 'p'){$paragraphDepth--}
   if($clipped){break}
  }}finally{$reader.Dispose()}
  $gaps=@('仅提取正文段落和表格内文字；未解释批注、修订取舍、公式对象、图像、化学结构或版式。删除修订文字也可能出现，须回到原件核验。')
 }else{
  $shared=[Collections.Generic.List[string]]::new();$entry=$archive.GetEntry('xl/sharedStrings.xml')
  if($entry){$reader=Open-SafeXml $entry;try{while($reader.Read()){if($reader.NodeType -eq [Xml.XmlNodeType]::Element -and $reader.LocalName -eq 'si'){$shared.Add((Read-SharedString $reader))}}}finally{$reader.Dispose()}}
  foreach($entry in @($archive.Entries|Where-Object {$_.FullName -match '^xl/worksheets/sheet\d+\.xml$'}|Sort-Object FullName)){
   $reader=Open-SafeXml $entry;Add-Line ('['+$entry.FullName+']')
   try{while(!$clipped -and $reader.Read()){
    if($reader.NodeType -ne [Xml.XmlNodeType]::Element -or $reader.LocalName -ne 'c'){continue}
    $coordinate=$reader.GetAttribute('r');$type=$reader.GetAttribute('t');$cell=Read-Cell $reader;$value=$cell.value
    if($type -eq 's' -and $value -match '^\d+$'){$index=[int]$value;if($index -ge $shared.Count){throw 'Shared string index invalid'};$value=$shared[$index]}
    if($null -ne $cell.formula){$value='formula='+$cell.formula+'; cached='+$value}
    Add-Line ($coordinate+'='+$value);if($cell.truncated){$clipped=$true}
   }}finally{$reader.Dispose()}
   if($clipped){break}
  }
  $gaps=@('仅保留工作表文件名、单元格坐标、原始值和公式缓存；不计算公式，不解释日期格式、显示单位、图表、合并布局或图片。')
 }
 if($clipped){$gaps+='文本超过 60000 字符，达到预算后停止正文解析；尾部未进入提取结果，原件仍完整保留。'}
 @{text=$text.ToString();gaps=$gaps}|ConvertTo-Json -Depth 4 -Compress
}finally{$archive.Dispose()}
