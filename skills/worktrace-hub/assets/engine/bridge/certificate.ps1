param([Parameter(Mandatory=$true)][string]$Spec)
$ErrorActionPreference='Stop'
$s=Get-Content -LiteralPath $Spec -Raw -Encoding UTF8 | ConvertFrom-Json
$rsa=[System.Security.Cryptography.RSA]::Create(2048)
$req=[System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=WorkTrace Local Hub',$rsa,[System.Security.Cryptography.HashAlgorithmName]::SHA256,[System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
$san=[System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$san.AddDnsName('localhost')
foreach($ip in $s.addresses){$san.AddIpAddress([System.Net.IPAddress]::Parse($ip))}
$req.CertificateExtensions.Add($san.Build())
$req.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false,$false,0,$true))
$req.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment),$true))
$cert=$req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1),[DateTimeOffset]::UtcNow.AddYears(2))
[IO.File]::WriteAllBytes($s.pfx,$cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx,$s.password))
$pem="-----BEGIN CERTIFICATE-----`n"+[Convert]::ToBase64String($cert.RawData,[Base64FormattingOptions]::InsertLineBreaks)+"`n-----END CERTIFICATE-----`n"
[IO.File]::WriteAllText($s.pem,$pem,[Text.UTF8Encoding]::new($false))
$cert.Dispose();$rsa.Dispose()
Write-Output 'certificate-created'
