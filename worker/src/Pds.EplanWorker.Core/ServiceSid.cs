using System;
using System.Security.Cryptography;
using System.Text;

namespace Pds.EplanWorker
{
    /// <summary>
    /// SID des virtuellen Dienstkontos <c>NT SERVICE\&lt;Dienst&gt;</c>. Windows bildet sie fest aus dem Dienstnamen
    /// (S-1-5-80 + SHA-1 des Namens in Großbuchstaben, UTF-16LE). So kann die Pipe-ACL das Konto auch dann enthalten,
    /// wenn der Web-Dienst (noch) nicht installiert ist – über den Namen ließe es sich dann nicht auflösen.
    /// </summary>
    public static class ServiceSid
    {
        public static string For(string serviceName)
        {
            if (string.IsNullOrEmpty(serviceName))
            {
                throw new ArgumentException("Dienstname fehlt.", nameof(serviceName));
            }

            byte[] hash;
            using (var sha1 = SHA1.Create())
            {
                hash = sha1.ComputeHash(Encoding.Unicode.GetBytes(serviceName.ToUpperInvariant()));
            }

            var sid = new StringBuilder("S-1-5-80");
            for (int i = 0; i < 5; i++)
            {
                // Unterautoritäten: je 4 Byte des Hashs, little-endian
                uint value = (uint)(hash[i * 4] | hash[i * 4 + 1] << 8 | hash[i * 4 + 2] << 16 | hash[i * 4 + 3] << 24);
                sid.Append('-').Append(value);
            }
            return sid.ToString();
        }
    }
}
