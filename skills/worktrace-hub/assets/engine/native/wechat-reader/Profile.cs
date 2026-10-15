using System;
using System.Collections.Generic;
using System.IO;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

internal sealed class Profile {
    internal string Root, Account;
    internal Dictionary<string,string> Keys;
    internal const string Format="worktrace.wechat-native-profile/1.0";
    internal static readonly JavaScriptSerializer Json=new JavaScriptSerializer {MaxJsonLength=1024*1024,RecursionLimit=12};
    internal static string LocalPath(string value) {
        if(String.IsNullOrEmpty(value)||!Path.IsPathRooted(value)||value.StartsWith("\\\\")||value.IndexOf('\0')>=0||value.IndexOf(':',2)>=0)throw new ReaderError("local_absolute_path_required");
        return Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar);
    }
    internal static void NoLinks(string path) {
        string current=Path.GetFullPath(path);
        while(!String.IsNullOrEmpty(current)) {
            if((File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0)throw new ReaderError("filesystem_link_rejected");
            var parent=Directory.GetParent(current);current=parent==null?null:parent.FullName;
        }
    }
    internal string Database(string path) {
        path=LocalPath(path);
        if(!path.StartsWith(Root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)||!path.EndsWith(".db",StringComparison.OrdinalIgnoreCase))throw new ReaderError("database_outside_profile");
        NoLinks(path);
        foreach(string suffix in new[]{"-wal","-shm"})if(File.Exists(path+suffix))NoLinks(path+suffix);
        return path;
    }
    static byte[] Entropy(string root,string account) {return Encoding.UTF8.GetBytes(Format+"\n"+root.ToLowerInvariant()+"\n"+account);}
    internal static Profile Load(string path) {
        path=LocalPath(path);NoLinks(path);if(new FileInfo(path).Length>1024*1024)throw new ReaderError("profile_limit");
        var data=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(path,Encoding.UTF8));
        if(data==null||Convert.ToString(data["format"])!=Format)throw new ReaderError("profile_format");
        var profile=new Profile {Root=LocalPath(Convert.ToString(data["account_root"])),Account=Convert.ToString(data["account_id"])};
        if(String.IsNullOrEmpty(profile.Account)||profile.Account.Length>160)throw new ReaderError("profile_account");
        NoLinks(profile.Root);
        byte[] decrypted=ProtectedData.Unprotect(Convert.FromBase64String(Convert.ToString(data["encrypted_keymap_base64"])),Entropy(profile.Root,profile.Account),DataProtectionScope.CurrentUser);
        try {profile.Keys=Json.Deserialize<Dictionary<string,string>>(Encoding.UTF8.GetString(decrypted));}
        finally {Array.Clear(decrypted,0,decrypted.Length);}
        if(profile.Keys==null||profile.Keys.Count==0||profile.Keys.Count>2000)throw new ReaderError("profile_keys");
        foreach(var pair in profile.Keys)if(!Regex.IsMatch(pair.Key,"^[a-f0-9]{32}$")||!Regex.IsMatch(pair.Value,"^[a-f0-9]{64}$"))throw new ReaderError("profile_keys");
        return profile;
    }
    internal static void Save(string path,string root,string account,Dictionary<string,string> keys) {
        path=LocalPath(path);root=LocalPath(root);NoLinks(root);
        if(File.Exists(path)||Directory.Exists(path))throw new ReaderError("profile_already_exists");
        string parent=Path.GetDirectoryName(path);NoLinks(parent);
        byte[] clear=Encoding.UTF8.GetBytes(Json.Serialize(keys)),encrypted;
        try {encrypted=ProtectedData.Protect(clear,Entropy(root,account),DataProtectionScope.CurrentUser);}
        finally {Array.Clear(clear,0,clear.Length);}
        var data=new Dictionary<string,object>{{"format",Format},{"account_root",root},{"account_id",account},{"created_at",DateTime.UtcNow.ToString("o")},{"key_count",keys.Count},{"encrypted_keymap_base64",Convert.ToBase64String(encrypted)}};
        var acl=new FileSecurity();acl.SetAccessRuleProtection(true,false);
        acl.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User,FileSystemRights.FullControl,AccessControlType.Allow));
        acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null),FileSystemRights.FullControl,AccessControlType.Allow));
        using(var stream=new FileStream(path,FileMode.CreateNew,FileSystemRights.Write,FileShare.None,4096,FileOptions.WriteThrough,acl)) {
            byte[] bytes=Encoding.UTF8.GetBytes(Json.Serialize(data));stream.Write(bytes,0,bytes.Length);stream.Flush(true);
        }
    }
}
