# Native reader dependencies

The build downloads Tencent WCDB 2.1.16, commit
`df808591b9f9a9ab42156006819c3550d5af13a3`, and compiles its SQLCipher C core.
Tencent WCDB is BSD 3-Clause. SQLCipher contains its own BSD-style notices and
SQLite public-domain code. The build copies the complete upstream WCDB and
SQLCipher license files alongside the executable. It does not link or ship the
archive's OpenSSL 1.1.1 library. Cryptography is provided by Windows BCrypt/CNG.

The Windows raw SQLCipher literal scan was adapted from the following MIT work:
https://github.com/r266-tech/wx-cli/blob/d833d68737454169848760642b2127302911de1b/internal/wxkey/setup_windows.go

MIT License

Copyright (c) 2026 R266 Tech

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

LLVM-MinGW 20260616 is a build-time tool only, not shipped with the reader. Its
archive is pinned by SHA256; its component notices remain in the build cache.
