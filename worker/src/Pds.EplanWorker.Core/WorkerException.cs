using System;

namespace Pds.EplanWorker
{
    /// <summary>Fehler mit Code für <c>response.error</c>; die Meldung ist Rohtext ohne Geheimnisse.</summary>
    public sealed class WorkerException : Exception
    {
        public WorkerException(string code, string message)
            : base(message)
        {
            Code = code;
        }

        public WorkerException(string code, string message, Exception innerException)
            : base(message, innerException)
        {
            Code = code;
        }

        /// <summary>Einer der Codes aus <see cref="Protocol.ErrorCodes"/>.</summary>
        public string Code { get; }
    }
}
