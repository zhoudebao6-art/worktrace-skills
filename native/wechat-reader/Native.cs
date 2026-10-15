// WorkTrace native database boundary. No WeChat process or UI access.
using System;
using System.Runtime.InteropServices;
using System.Text;

internal static class Native {
    internal const string Library = "worktrace-wcdb.dll";
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] internal static extern IntPtr LoadLibraryEx(string path, IntPtr reserved, uint flags);
    [StructLayout(LayoutKind.Sequential)] internal struct FileInformation {
        internal uint Attributes,CreationLow,CreationHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
    }
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool GetFileInformationByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle handle,out FileInformation information);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] internal static extern int sqlite3_open_v2(byte[] path, out IntPtr db, int flags, IntPtr vfs);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] internal static extern int sqlite3_close_v2(IntPtr db);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] internal static extern int sqlite3_key_v2(IntPtr db, byte[] name, byte[] key, int length);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] internal static extern int sqlite3_prepare_v2(IntPtr db, byte[] sql, int length, out IntPtr statement, IntPtr tail);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] internal static extern int sqlite3_step(IntPtr statement);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] internal static extern int sqlite3_finalize(IntPtr statement);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] internal static extern int sqlite3_stmt_readonly(IntPtr statement);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] internal static extern int sqlite3_db_readonly(IntPtr db, byte[] name);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] internal static extern int sqlite3_column_count(IntPtr statement);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] internal static extern IntPtr sqlite3_column_name(IntPtr statement, int column);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] internal static extern int sqlite3_column_type(IntPtr statement, int column);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] internal static extern long sqlite3_column_int64(IntPtr statement, int column);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] internal static extern double sqlite3_column_double(IntPtr statement, int column);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] internal static extern IntPtr sqlite3_column_text(IntPtr statement, int column);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] internal static extern IntPtr sqlite3_column_blob(IntPtr statement, int column);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] internal static extern int sqlite3_column_bytes(IntPtr statement, int column);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] internal static extern int sqlite3_bind_int64(IntPtr statement, int column, long value);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] internal static extern int sqlite3_bind_text(IntPtr statement, int column, byte[] value, int length, IntPtr destructor);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] internal static extern int sqlite3_busy_timeout(IntPtr db, int milliseconds);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] internal static extern int sqlite3_limit(IntPtr db, int category, int limit);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] internal delegate int Progress(IntPtr context);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] internal static extern void sqlite3_progress_handler(IntPtr db, int instructions, Progress callback, IntPtr context);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] internal static extern IntPtr sqlite3_libversion();
    internal static byte[] Utf8(string text) { return Encoding.UTF8.GetBytes(text + "\0"); }
    internal static string Text(IntPtr pointer) {
        if (pointer == IntPtr.Zero) return "";
        int length=0; while (Marshal.ReadByte(pointer,length)!=0 && length<4096) length++;
        byte[] bytes=new byte[length]; Marshal.Copy(pointer,bytes,0,length); return Encoding.UTF8.GetString(bytes);
    }
    internal static void Check(int code) { if(code!=0) throw new ReaderError("database_error_"+code); }
    internal static IntPtr Prepare(IntPtr db,string sql) {
        IntPtr statement; byte[] bytes=Utf8(sql); int code=sqlite3_prepare_v2(db,bytes,bytes.Length,out statement,IntPtr.Zero);
        if(code!=0) { if(statement!=IntPtr.Zero) sqlite3_finalize(statement); Check(code); }
        return statement;
    }
    internal static void Execute(IntPtr db,string sql) {
        IntPtr statement=Prepare(db,sql);
        try { int code; do {code=sqlite3_step(statement);}while(code==100); if(code!=101) Check(code); }
        finally { sqlite3_finalize(statement); }
    }
}
internal sealed class ReaderError:Exception { internal ReaderError(string code):base(code){} }
