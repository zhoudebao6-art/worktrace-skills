// Test-only executable. Not distributed with the production reader/setup bundle.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

internal static class Fixture {
    static readonly string Table=ConversationTable();
    static string ConversationTable() {using(var hash=MD5.Create())return "Msg_"+BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes("fixture-other"))).Replace("-","").ToLowerInvariant();}
    public static int Main(string[] args) {
        IntPtr db=IntPtr.Zero;GCHandle pinned=default(GCHandle);byte[] literal=null;
        try {
            string root=Profile.LocalPath(args[0]),profile=Profile.LocalPath(args[1]);Directory.CreateDirectory(Path.Combine(root,"db_storage","message"));
            string path=Path.Combine(root,"db_storage","message","message_0.db");if(File.Exists(path))throw new ReaderError("fixture_exists");
            string dll=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,Native.Library);if(Native.LoadLibraryEx(dll,IntPtr.Zero,0x100|0x800)==IntPtr.Zero)throw new ReaderError("codec_load_failed");
            byte[] bytes;using(var hash=SHA256.Create())bytes=hash.ComputeHash(Encoding.ASCII.GetBytes("worktrace native synthetic fixture key"));string key=BitConverter.ToString(bytes).Replace("-","").ToLowerInvariant();Array.Clear(bytes,0,bytes.Length);
            bytes=Encoding.ASCII.GetBytes("x'"+key+"'");Native.Check(Native.sqlite3_open_v2(Native.Utf8(path),out db,6,IntPtr.Zero));Native.Check(Native.sqlite3_key_v2(db,Native.Utf8("main"),bytes,bytes.Length));Array.Clear(bytes,0,bytes.Length);
            Native.Execute(db,"CREATE TABLE Name2Id(user_name TEXT)");Native.Execute(db,"INSERT INTO Name2Id(rowid,user_name) VALUES(1,'fixture-self'),(2,'fixture-other')");
            Native.Execute(db,"CREATE TABLE "+Table+"(local_id INTEGER,server_id INTEGER,sort_seq INTEGER,create_time INTEGER,local_type INTEGER,real_sender_id INTEGER,message_content BLOB,source TEXT,WCDB_CT_message_content INTEGER)");
            Native.Execute(db,"INSERT INTO "+Table+" VALUES(7,9007199254740993,1,1700000000,1,2,'first',NULL,0)");
            bytes=new byte[16];using(var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite)){if(stream.Read(bytes,0,16)!=16)throw new ReaderError("header");}
            string salt=BitConverter.ToString(bytes).Replace("-","").ToLowerInvariant();literal=Encoding.ASCII.GetBytes("x'"+key+salt+"'");pinned=GCHandle.Alloc(literal,GCHandleType.Pinned);
            Profile.Save(profile,root,"fixture-self",new Dictionary<string,string>{{salt,key}});
            Native.Execute(db,"PRAGMA journal_mode=WAL");Native.Execute(db,"PRAGMA wal_autocheckpoint=0");
            Native.Execute(db,"INSERT INTO "+Table+" VALUES(7,9007199254740994,2,1700000001,1,999,x'28b52ffd','synthetic source',4)");
            Console.WriteLine(Profile.Json.Serialize(new{ok=true,database_path=path,table_id=Table,pid=System.Diagnostics.Process.GetCurrentProcess().Id}));
            string command;while((command=Console.ReadLine())!=null){
                if(command=="append")Native.Execute(db,"INSERT INTO "+Table+" VALUES(8,9007199254740995,3,1700000002,1,1,'third',NULL,0)");
                else if(command=="uncommitted") {Native.Execute(db,"BEGIN IMMEDIATE");Native.Execute(db,"INSERT INTO "+Table+" VALUES(9,9007199254740996,4,1700000003,1,2,'uncommitted',NULL,0)");}
                else if(command=="rollback")Native.Execute(db,"ROLLBACK");
                else if(command=="oversize")Native.Execute(db,"INSERT INTO "+Table+" VALUES(10,9007199254740997,5,1700000004,1,2,zeroblob(600000),NULL,0)");
                else if(command=="exit")break;else throw new ReaderError("fixture_command");
                Console.WriteLine("{\"ok\":true}");
            }
            return 0;
        }catch(Exception ex){Console.WriteLine(Profile.Json.Serialize(new{ok=false,error=ex is ReaderError?ex.Message:ex.GetType().Name}));return 1;}
        finally{if(db!=IntPtr.Zero)Native.sqlite3_close_v2(db);if(pinned.IsAllocated)pinned.Free();if(literal!=null)Array.Clear(literal,0,literal.Length);}
    }
}
