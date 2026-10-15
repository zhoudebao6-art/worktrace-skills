// Explicit, one-shot, read-only preparation. No injection, hooking, UI, process restart or background retry.
// Raw SQLCipher literal search is adapted from MIT wx-cli (see THIRD-PARTY-NOTICES.md).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class Setup {
    [StructLayout(LayoutKind.Sequential)] struct MemoryInformation {internal IntPtr Base,AllocationBase;internal uint AllocationProtect;internal UIntPtr RegionSize;internal uint State,Protect,Type;}
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",SetLastError=true)] static extern UIntPtr VirtualQueryEx(IntPtr process,IntPtr address,out MemoryInformation info,UIntPtr size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadProcessMemory(IntPtr process,IntPtr address,byte[] buffer,UIntPtr size,out UIntPtr read);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,int flags,StringBuilder path,ref int size);
    [StructLayout(LayoutKind.Sequential)] struct LastInput {internal uint Size,Tick;}
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput input);
    static void RequireIdle(uint seconds) {
#if SYNTHETIC_SETUP
        string mocked=Environment.GetEnvironmentVariable("WORKTRACE_TEST_IDLE_SECONDS");if(mocked==null)return;
        uint value;if(!UInt32.TryParse(mocked,out value)||value<seconds)throw new ReaderError("employee_active");
#else
        var input=new LastInput {Size=(uint)Marshal.SizeOf(typeof(LastInput))};
        if(!GetLastInputInfo(ref input))throw new ReaderError("idle_status_unavailable");
        uint elapsed=unchecked((uint)Environment.TickCount-input.Tick);if(elapsed/1000<seconds)throw new ReaderError("employee_active");
#endif
    }
    static string Salt(string path) {using(var f=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite)){byte[] b=new byte[16];if(f.Read(b,0,16)!=16)throw new ReaderError("database_header_short");return BitConverter.ToString(b).Replace("-","").ToLowerInvariant();}}
    static bool Verify(string path,string salt,string key) {
        IntPtr db=IntPtr.Zero;byte[] raw=Encoding.ASCII.GetBytes("x'"+key+salt+"'");
        try {Profile.NoLinks(path);Native.Check(Native.sqlite3_open_v2(Native.Utf8(path),out db,1,IntPtr.Zero));Native.Check(Native.sqlite3_key_v2(db,Native.Utf8("main"),raw,raw.Length));Native.sqlite3_busy_timeout(db,500);Native.Execute(db,"SELECT count(*) FROM sqlite_master");return true;}
        catch{return false;}finally{Array.Clear(raw,0,raw.Length);if(db!=IntPtr.Zero)Native.sqlite3_close_v2(db);}
    }
    static bool HasAccount(string path,string salt,string key,string account) {
        IntPtr db=IntPtr.Zero,statement=IntPtr.Zero;byte[] raw=Encoding.ASCII.GetBytes("x'"+key+salt+"'");
        try {Native.Check(Native.sqlite3_open_v2(Native.Utf8(path),out db,1,IntPtr.Zero));Native.Check(Native.sqlite3_key_v2(db,Native.Utf8("main"),raw,raw.Length));Native.sqlite3_busy_timeout(db,500);
            statement=Native.Prepare(db,"SELECT 1 FROM Name2Id WHERE user_name=? LIMIT 1");byte[] name=Encoding.UTF8.GetBytes(account);Native.Check(Native.sqlite3_bind_text(statement,1,name,name.Length,new IntPtr(-1)));return Native.sqlite3_step(statement)==100;
        }catch{return false;}finally {Array.Clear(raw,0,raw.Length);if(statement!=IntPtr.Zero)Native.sqlite3_finalize(statement);if(db!=IntPtr.Zero)Native.sqlite3_close_v2(db);}
    }
    static bool Hex(byte b) {return (b>=48&&b<=57)||(b>=65&&b<=70)||(b>=97&&b<=102);}
    static void Scan(byte[] data,int length,Dictionary<string,string> sources,Dictionary<string,string> verified) {
        for(int i=0;i+99<=length;i++){
            if(data[i]!=120||data[i+1]!=39||data[i+98]!=39)continue;
            bool valid=true;for(int j=i+2;j<i+98;j++)if(!Hex(data[j])){valid=false;break;}if(!valid)continue;
            string salt=Encoding.ASCII.GetString(data,i+66,32).ToLowerInvariant(),path;
            if(verified.ContainsKey(salt)||!sources.TryGetValue(salt,out path))continue;
            string key=Encoding.ASCII.GetString(data,i+2,64).ToLowerInvariant();
            if(Verify(path,salt,key))verified.Add(salt,key);
        }
    }
    static Dictionary<string,string> Sources(string root) {
        string storage=Path.Combine(root,"db_storage");Profile.NoLinks(storage);
        var paths=new Stack<string>();paths.Push(storage);var result=new Dictionary<string,string>();int files=0,directories=0;
        while(paths.Count>0){RequireIdle(30);string directory=paths.Pop();if(++directories>2000)throw new ReaderError("database_directory_limit");Profile.NoLinks(directory);
            foreach(string path in Directory.EnumerateFiles(directory,"*.db")){if(++files>2000)throw new ReaderError("database_file_limit");Profile.NoLinks(path);string salt=Salt(path);if(!result.ContainsKey(salt))result.Add(salt,path);}
            foreach(string child in Directory.EnumerateDirectories(directory)){Profile.NoLinks(child);paths.Push(child);}
        }return result;
    }
    public static int Main(string[] args) {
        Console.OutputEncoding=new UTF8Encoding(false);
        try {
            if(args.Length!=12||args[0]!="--dll"||args[2]!="--profile"||args[4]!="--account-root"||args[6]!="--account-id"||args[8]!="--pid"||args[10]!="--timeout-seconds")throw new ReaderError("usage_setup_arguments");
            string dll=Profile.LocalPath(args[1]),profile=Profile.LocalPath(args[3]),root=Profile.LocalPath(args[5]),account=args[7];int pid,timeout;
            if(!Int32.TryParse(args[9],out pid)||pid<=0||!Int32.TryParse(args[11],out timeout)||timeout<1||timeout>180)throw new ReaderError("invalid_setup_limit");
            if(account.Length==0||account.Length>160||account.IndexOf('\0')>=0)throw new ReaderError("invalid_account");
            if(File.Exists(profile)||Directory.Exists(profile))throw new ReaderError("profile_already_exists");Profile.NoLinks(Path.GetDirectoryName(profile));Profile.NoLinks(root);Profile.NoLinks(dll);
            if(Path.GetFileName(dll)!=Native.Library||Native.LoadLibraryEx(dll,IntPtr.Zero,0x100|0x800)==IntPtr.Zero)throw new ReaderError("codec_load_failed");
            Dictionary<string,string> sources=null;
            Process.GetCurrentProcess().PriorityClass=ProcessPriorityClass.BelowNormal;
            // Minimum rights: never request VM_WRITE, VM_OPERATION, CREATE_THREAD or ALL_ACCESS.
            IntPtr process=OpenProcess(0x10|0x400,false,pid);if(process==IntPtr.Zero)throw new ReaderError("process_read_access_denied");
            var verified=new Dictionary<string,string>();long total=0;var watch=Stopwatch.StartNew();
            try {
                var image=new StringBuilder(32768);int size=image.Capacity;if(!QueryFullProcessImageName(process,0,image,ref size))throw new ReaderError("process_image_unavailable");
                string executable=Path.GetFileName(image.ToString());
                bool allowed=String.Equals(executable,"Weixin.exe",StringComparison.OrdinalIgnoreCase)||String.Equals(executable,"WeChat.exe",StringComparison.OrdinalIgnoreCase);
#if SYNTHETIC_SETUP
                allowed=String.Equals(executable,"worktrace-native-fixture.exe",StringComparison.OrdinalIgnoreCase);
#endif
                if(!allowed)throw new ReaderError("process_name_not_allowed");
                RequireIdle(120);
                sources=Sources(root);if(sources.Count==0)throw new ReaderError("no_account_databases");
#if !SYNTHETIC_SETUP
                string folder=Path.GetFileName(root);if(!String.Equals(folder,account,StringComparison.OrdinalIgnoreCase)&&!folder.StartsWith(account+"_",StringComparison.OrdinalIgnoreCase))throw new ReaderError("account_root_mismatch");
#endif
                const int Chunk=1024*1024;
                    for(long address=0;address<0x00007fffffffffffL&&watch.Elapsed.TotalSeconds<timeout&&total<1024L*1024*1024&&verified.Count<sources.Count;){
                        MemoryInformation info;if(VirtualQueryEx(process,new IntPtr(address),out info,(UIntPtr)Marshal.SizeOf(typeof(MemoryInformation)))==UIntPtr.Zero)break;
                        long start=info.Base.ToInt64(),length=checked((long)info.RegionSize.ToUInt64()),next=checked(start+length);if(next<=address)break;
                        if(info.State==0x1000&&(info.Protect&0x101)==0){
                            for(long offset=0;offset<length&&watch.Elapsed.TotalSeconds<timeout&&total<1024L*1024*1024&&verified.Count<sources.Count;){
                                RequireIdle(30);
                                int count=(int)Math.Min(Chunk,length-offset);byte[] chunk=new byte[count];UIntPtr read;
                                bool ok=ReadProcessMemory(process,new IntPtr(start+offset),chunk,(UIntPtr)count,out read);int got=(int)Math.Min((ulong)count,read.ToUInt64());total+=got;
                                try {if(ok&&got>0)Scan(chunk,got,sources,verified);}finally {Array.Clear(chunk,0,chunk.Length);}
                                // Re-read 98 bytes only after a complete successful chunk so split literals remain visible.
                                offset+=count;if(ok&&got==count&&count>98&&offset<length)offset-=98;
                                Thread.Sleep(2);
                            }
                        }address=next;
                    }
            }finally{CloseHandle(process);}
            if(verified.Count==0)throw new ReaderError("no_verified_keys_within_budget");
            RequireIdle(30);
            bool accountFound=false;foreach(var pair in verified)if(HasAccount(sources[pair.Key],pair.Key,pair.Value,account)){accountFound=true;break;}
            if(!accountFound)throw new ReaderError("account_not_present_in_name2id");
            Profile.Save(profile,root,account,verified);
            Console.WriteLine(Profile.Json.Serialize(new{ok=true,complete=verified.Count==sources.Count,profile_path=profile,account_id=account,verified_salts=verified.Count,target_salts=sources.Count,scanned_bytes=total,elapsed_ms=watch.ElapsedMilliseconds}));return 0;
        }catch(Exception ex){Console.WriteLine(Profile.Json.Serialize(new{ok=false,error=ex is ReaderError?ex.Message:"setup_failed"}));return 1;}
    }
}
