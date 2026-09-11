using System;
using System.Collections.Concurrent;
using System.Threading;

internal sealed class LiveDocumentWorker : IDisposable
{
    private readonly BlockingCollection<Action<LiveDocument>> Queue = new BlockingCollection<Action<LiveDocument>>(1);
    private readonly Thread Worker;
    internal LiveDocumentWorker()
    {
        Worker = new Thread(delegate()
        {
            using (var document = new LiveDocument()) foreach (var action in Queue.GetConsumingEnumerable()) action(document);
        }) { IsBackground = true, Name = "Live document worker" };
        Worker.SetApartmentState(ApartmentState.STA); Worker.Start();
    }
    internal object Run(Func<LiveDocument, object> action)
    {
        object result = null; Exception error = null;
        using (var done = new ManualResetEventSlim())
        {
            Queue.Add(delegate(LiveDocument document) { try { result = action(document); } catch (Exception caught) { error = caught; } finally { done.Set(); } });
            // The owner bounds the entire native request and terminates a stuck helper.
            done.Wait();
        }
        if (error != null) throw error;
        return result;
    }
    public void Dispose() { Queue.CompleteAdding(); Worker.Join(500); }
}
