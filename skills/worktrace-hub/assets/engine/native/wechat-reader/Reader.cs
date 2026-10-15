// JSON stdin/out only. The host never discovers accounts or obtains credentials.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

internal static class Reader {
    const int MaxOutputBytes=4*1024*1024, MaxCellBytes=512*1024;
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer { MaxJsonLength=8*1024*1024, RecursionLimit=16 };
    static Profile profile;
    static string Required(Dictionary<string,object> request,string name) {
        object value; if(!request.TryGetValue(name,out value)||!(value is string)||String.IsNullOrWhiteSpace((string)value)) throw new ReaderError("invalid_"+name);
        return (string)value;
    }
    static string Optional(Dictionary<string,object> request,string name,string fallback) { return request.ContainsKey(name)?Required(request,name):fallback; }
    static long Cursor(Dictionary<string,object> request,string name,string fallback) {
        string value=Optional(request,name,fallback);long parsed;
        if(!Regex.IsMatch(value,"^(0|[1-9][0-9]{0,18})$")||!Int64.TryParse(value,NumberStyles.None,CultureInfo.InvariantCulture,out parsed)) throw new ReaderError("invalid_"+name);
        return parsed;
    }
    static int Number(Dictionary<string,object> request,string name,int fallback,int min,int max) {
        object value;if(!request.TryGetValue(name,out value))return fallback;
        if(!(value is int)||(int)value<min||(int)value>max)throw new ReaderError("invalid_"+name);
        return (int)value;
    }
    static string Hash(byte[] value) { using(var sha=SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(value)).Replace("-","").ToLowerInvariant(); }
    static Dictionary<string,object> Run(Dictionary<string,object> request) {
        foreach(string name in request.Keys) if(Array.IndexOf(new[]{"id","database_path","shard_id","table_id","query","after","through","limit","timeout_ms","expected_generation"},name)<0)throw new ReaderError("unknown_field");
        string path=Required(request,"database_path"), shard=Required(request,"shard_id"), query=Required(request,"query");
        if(!Path.IsPathRooted(path)||path.StartsWith("\\\\")||path.IndexOf('\0')>=0||path.IndexOf(':',2)>=0)throw new ReaderError("invalid_database_path");
        path=profile.Database(path);if(!File.Exists(path))throw new ReaderError("database_missing");
        if(shard.Length>200||shard.IndexOf('\0')>=0)throw new ReaderError("invalid_shard_id");
        string table=Optional(request,"table_id","");
        if(query!="schema"&&query!="name2id"&&!Regex.IsMatch(table,"^Msg_[a-fA-F0-9]{32}$"))throw new ReaderError("invalid_table_id");
        if(query!="schema"&&query!="name2id"&&query!="head"&&query!="messages")throw new ReaderError("query_not_allowed");
        int limit=Number(request,"limit",100,1,500),timeout=Number(request,"timeout_ms",2000,50,10000);
        long after=Cursor(request,"after","0"),through=Cursor(request,"through",Int64.MaxValue.ToString(CultureInfo.InvariantCulture));
        if(after>through)throw new ReaderError("invalid_cursor_range");
        // Deny replacement/deletion of the main file for the duration of this read.
        using(var guard=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite)) {
            byte[] header=new byte[16];if(guard.Read(header,0,16)!=16)throw new ReaderError("invalid_database_header");
            string salt=BitConverter.ToString(header).Replace("-","").ToLowerInvariant(),key;
            if(!profile.Keys.TryGetValue(salt,out key))throw new ReaderError("key_not_prepared");
            Native.FileInformation fileInfo;if(!Native.GetFileInformationByHandle(guard.SafeFileHandle,out fileInfo))throw new ReaderError("file_identity_unavailable");
            string generation=Hash(Encoding.ASCII.GetBytes(salt+":"+fileInfo.Volume+":"+fileInfo.IndexHigh+":"+fileInfo.IndexLow));
            if(request.ContainsKey("expected_generation")&&Required(request,"expected_generation")!=generation)throw new ReaderError("database_generation_changed");
            IntPtr db=IntPtr.Zero;Native.Progress progress=null;byte[] keyBytes=Encoding.ASCII.GetBytes("x'"+key+salt+"'");
            try {
                Native.Check(Native.sqlite3_open_v2(Native.Utf8(path),out db,1,IntPtr.Zero));
                Native.Check(Native.sqlite3_key_v2(db,Native.Utf8("main"),keyBytes,keyBytes.Length));
                Array.Clear(keyBytes,0,keyBytes.Length);
                if(Native.sqlite3_db_readonly(db,Native.Utf8("main"))!=1)throw new ReaderError("readonly_open_required");
                Native.sqlite3_busy_timeout(db,Math.Min(timeout,1000));
                Native.sqlite3_limit(db,0,MaxCellBytes);Native.sqlite3_limit(db,1,65536);
                var watch=Stopwatch.StartNew();progress=delegate(IntPtr ignored) { return watch.ElapsedMilliseconds>=timeout?1:0; };
                Native.sqlite3_progress_handler(db,1000,progress,IntPtr.Zero);
                Native.Execute(db,"BEGIN");
                string sql;
                if(query=="schema")sql="SELECT rowid AS cursor,name FROM sqlite_master WHERE type='table' AND (name GLOB 'Msg_*' OR name='Name2Id') AND rowid>? AND rowid<=? ORDER BY rowid LIMIT "+(limit+1);
                else if(query=="head")sql="SELECT coalesce(max(rowid),0) AS high_watermark FROM \""+table+"\"";
                else if(query=="name2id")sql="SELECT rowid AS cursor,user_name FROM Name2Id WHERE rowid>? AND rowid<=? ORDER BY rowid ASC LIMIT "+(limit+1);
                else {
                    // Schema drift is explicit. Compression marker is optional in older databases.
                    bool compressed=false;IntPtr columns=Native.Prepare(db,"PRAGMA table_info(\""+table+"\")");
                    try {int rc;while((rc=Native.sqlite3_step(columns))==100)if(Native.Text(Native.sqlite3_column_text(columns,1))=="WCDB_CT_message_content")compressed=true;if(rc!=101)Native.Check(rc);}
                    finally {Native.sqlite3_finalize(columns);}
                    sql="SELECT m.rowid AS cursor,m.local_id,m.server_id,m.sort_seq,m.create_time,m.local_type,m.real_sender_id,n.user_name AS sender_username,m.message_content,m.source,"+(compressed?"m.WCDB_CT_message_content":"NULL AS WCDB_CT_message_content")+" FROM \""+table+"\" m LEFT JOIN Name2Id n ON n.rowid=m.real_sender_id WHERE m.rowid>? AND m.rowid<=? ORDER BY m.rowid ASC LIMIT "+(limit+1);
                }
                IntPtr statement=Native.Prepare(db,sql);var rows=new List<Dictionary<string,object>>();int bytes=0;bool more=false;
                try {
                    if(Native.sqlite3_stmt_readonly(statement)!=1)throw new ReaderError("readonly_statement_required");
                    if(query!="head") { Native.Check(Native.sqlite3_bind_int64(statement,1,after));Native.Check(Native.sqlite3_bind_int64(statement,2,through)); }
                    for(;;) {
                        int code=Native.sqlite3_step(statement);if(code==101)break;if(code!=100)Native.Check(code);
                        if(watch.ElapsedMilliseconds>=timeout)throw new ReaderError("query_timeout");
                        if(rows.Count==limit){more=true;break;}
                        var row=new Dictionary<string,object>();
                        for(int i=0;i<Native.sqlite3_column_count(statement);i++) {
                            string name=Native.Text(Native.sqlite3_column_name(statement,i));int type=Native.sqlite3_column_type(statement,i);object value=null;
                            if(type==1)value=Native.sqlite3_column_int64(statement,i).ToString(CultureInfo.InvariantCulture);
                            else if(type==2)value=Native.sqlite3_column_double(statement,i);
                            else if(type==3||type==4) {
                                int count=Native.sqlite3_column_bytes(statement,i);if(count>MaxCellBytes)throw new ReaderError("cell_limit");
                                byte[] data=new byte[count];IntPtr pointer=type==3?Native.sqlite3_column_text(statement,i):Native.sqlite3_column_blob(statement,i);
                                if(count>0)System.Runtime.InteropServices.Marshal.Copy(pointer,data,0,count);
                                if(type==4)value=new Dictionary<string,object>{{"encoding","base64"},{"data",Convert.ToBase64String(data)}};
                                else value=new UTF8Encoding(false,true).GetString(data);
                            }
                            row[name]=value;
                        }
                        bytes+=Encoding.UTF8.GetByteCount(Json.Serialize(row));if(bytes>MaxOutputBytes)throw new ReaderError("page_byte_limit");rows.Add(row);
                    }
                } finally {Native.sqlite3_finalize(statement);}
                Native.Execute(db,"ROLLBACK");
                var output=new Dictionary<string,object>{{"ok",true},{"complete",true},{"query",query},{"shard_id",shard},{"table_id",table},{"db_generation",generation},{"rows",rows},{"has_more",more},{"readonly",true}};
                if(query=="head")output["high_watermark"]=rows[0]["high_watermark"];
                if(query!="head")output["next_cursor"]=rows.Count==0?after.ToString(CultureInfo.InvariantCulture):rows[rows.Count-1]["cursor"];
                return output;
            } finally { Array.Clear(keyBytes,0,keyBytes.Length);if(db!=IntPtr.Zero){Native.sqlite3_progress_handler(db,0,null,IntPtr.Zero);Native.sqlite3_close_v2(db);}GC.KeepAlive(progress); }
        }
    }
    static string Line() {
        var text=new StringBuilder();for(;;){int c=Console.In.Read();if(c<0)return text.Length==0?null:text.ToString();if(c==10)return text.ToString().TrimEnd('\r');if(text.Length>=65536)throw new ReaderError("request_byte_limit");text.Append((char)c);}
    }
    public static int Main(string[] args) {
        Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
        try {
            if(args.Length!=4||args[0]!="--dll"||args[2]!="--profile")throw new ReaderError("usage_dll_profile");
            string dll=Profile.LocalPath(args[1]);if(Path.GetFileName(dll)!=Native.Library)throw new ReaderError("codec_filename");
            Profile.NoLinks(dll);if(Native.LoadLibraryEx(dll,IntPtr.Zero,0x00000100|0x00000800)==IntPtr.Zero)throw new ReaderError("codec_load_failed");
            profile=Profile.Load(args[3]);Process.GetCurrentProcess().PriorityClass=ProcessPriorityClass.BelowNormal;
            string line;while((line=Line())!=null){object id=null;try {var request=Json.Deserialize<Dictionary<string,object>>(line);if(request==null)throw new ReaderError("invalid_request");request.TryGetValue("id",out id);if(id!=null&&(!(id is string)||((string)id).Length>100))throw new ReaderError("invalid_id");var output=Run(request);output["id"]=id;Console.WriteLine(Json.Serialize(output));}catch(Exception ex){Console.WriteLine(Json.Serialize(new{id=id,ok=false,complete=false,error=ex is ReaderError?ex.Message:"request_failed"}));}}
            return 0;
        }catch(Exception ex){Console.WriteLine(Json.Serialize(new{ok=false,complete=false,error=ex is ReaderError?ex.Message:"startup_failed"}));return 1;}
    }
}
