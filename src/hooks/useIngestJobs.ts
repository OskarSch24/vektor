import { useCallback, useEffect, useRef, useState } from 'react';
import { IngestJob, IngestPayload, JobStage } from '../types/ingest';
import { Settings, Usage } from '../types/settings';
import { GraphTarget } from '../types/targets';
import { PipelineResult, runIngest } from '../services/ingest/pipeline';
import { graphEngine } from '../services/graphEngine';

interface UseIngestJobsOptions {
  readSettings: () => Settings;
  /** Records what a request actually consumed, as the provider reported it. */
  recordUsage: (delta: Partial<Usage>) => void;
  onGraphChanged: () => void;
  onError: (message: string) => void;
  onFinished: (job: IngestJob, result: PipelineResult) => void;
}

/**
 * The ingest queue.
 *
 * Jobs run one at a time on purpose. Each one may download a video, transcode
 * it and issue a dozen model calls; running three of those concurrently would
 * saturate the network, the CPU and the provider's rate limit at once, and make
 * every individual job slower than if they had simply waited their turn.
 */
export function useIngestJobs({
  readSettings,
  recordUsage,
  onGraphChanged,
  onError,
  onFinished,
}: UseIngestJobsOptions) {
  const [jobs, setJobs] = useState<IngestJob[]>([]);
  const queue = useRef<IngestJob[]>([]);
  const isRunning = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const runningJobId = useRef<string | null>(null);

  const patchJob = useCallback((id: string, patch: Partial<IngestJob>) => {
    setJobs((current) => current.map((job) => (job.id === id ? { ...job, ...patch } : job)));
  }, []);

  const resolveTarget = useCallback(
    (settings: Settings, targetId: string | undefined, targetPath?: string): GraphTarget => {
      // A path names one graph file directly — the database picked inside a
      // project — and beats any configured target.
      if (targetPath) {
        return {
          id: `file:${targetPath}`,
          name: targetPath.split('/').pop()?.replace(/\.graph$/i, '') || targetPath,
          kind: 'file',
          path: targetPath,
          createdAt: new Date().toISOString(),
        };
      }

      const requested = targetId
        ? settings.targets.find((target) => target.id === targetId)
        : undefined;
      const preferred =
        requested ??
        settings.targets.find((target) => target.id === settings.defaultTargetId) ??
        settings.targets[0];

      // With nothing configured the open graph is the target, so a fresh
      // install works the moment the extension is pointed at the app.
      return (
        preferred ?? {
          id: 'local',
          name: graphEngine.getName() || 'Offener Graph',
          kind: 'local',
          createdAt: new Date().toISOString(),
        }
      );
    },
    []
  );

  const drain = useCallback(async () => {
    if (isRunning.current) return;
    isRunning.current = true;

    while (queue.current.length > 0) {
      const job = queue.current.shift()!;
      const settings = readSettings();
      const target = resolveTarget(settings, job.payload.targetId, job.payload.targetPath);
      const controller = new AbortController();
      abortRef.current = controller;
      runningJobId.current = job.id;

      patchJob(job.id, { stage: 'fetching', message: 'Wird verarbeitet', progress: 0.02 });

      try {
        const result = await runIngest(job.payload, {
          settings,
          target,
          jobId: job.id,
          signal: controller.signal,
          onProgress: (stage: JobStage, progress, message) =>
            patchJob(job.id, { stage, progress, message }),
          recordUsage,
        });

        if (target.kind === 'local') {
          graphEngine.addSource(result.source);
          onGraphChanged();
        }

        const finished: IngestJob = {
          ...job,
          stage: 'done',
          progress: 1,
          message: `${result.nodesCreated} Knoten, ${result.edgesCreated} Kanten`,
          finishedAt: new Date().toISOString(),
          tokensUsed: (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0),
          result: {
            nodesCreated: result.nodesCreated,
            edgesCreated: result.edgesCreated,
            targetId: target.id,
          },
        };
        patchJob(job.id, finished);
        onFinished(finished, result);

        if (result.warnings.length > 0) {
          onError(result.warnings.join('\n'));
        }
      } catch (err) {
        const aborted = err instanceof DOMException && err.name === 'AbortError';
        const message = err instanceof Error ? err.message : String(err);
        patchJob(job.id, {
          stage: aborted ? 'cancelled' : 'failed',
          progress: null,
          message: aborted ? 'Abgebrochen' : 'Fehlgeschlagen',
          error: aborted ? undefined : message,
          finishedAt: new Date().toISOString(),
        });
        if (!aborted) onError(`"${job.payload.title || job.payload.url}": ${message}`);
      } finally {
        abortRef.current = null;
        runningJobId.current = null;
      }
    }

    isRunning.current = false;
  }, [onError, onFinished, onGraphChanged, patchJob, readSettings, recordUsage, resolveTarget]);

  const enqueue = useCallback(
    (payload: IngestPayload) => {
      const job: IngestJob = {
        id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        payload,
        stage: 'queued',
        progress: null,
        message: 'Wartet',
        createdAt: new Date().toISOString(),
      };

      setJobs((current) => [job, ...current]);
      queue.current.push(job);
      void drain();
      return job.id;
    },
    [drain]
  );

  const cancel = useCallback(
    (id: string) => {
      if (runningJobId.current === id) {
        abortRef.current?.abort();
        return;
      }
      // A queued job is simply removed; there is nothing to abort yet.
      queue.current = queue.current.filter((job) => job.id !== id);
      patchJob(id, {
        stage: 'cancelled',
        progress: null,
        message: 'Abgebrochen',
        finishedAt: new Date().toISOString(),
      });
    },
    [patchJob]
  );

  const retry = useCallback(
    (id: string) => {
      setJobs((current) => {
        const job = current.find((entry) => entry.id === id);
        if (!job) return current;
        const reset: IngestJob = {
          ...job,
          stage: 'queued',
          progress: null,
          message: 'Wartet',
          error: undefined,
          finishedAt: undefined,
        };
        queue.current.push(reset);
        void drain();
        return current.map((entry) => (entry.id === id ? reset : entry));
      });
    },
    [drain]
  );

  /** Stops the running job and drops everything still waiting. */
  const cancelAll = useCallback(() => {
    const waiting = new Set(queue.current.map((job) => job.id));
    queue.current = [];
    abortRef.current?.abort();

    setJobs((current) =>
      current.map((job) =>
        waiting.has(job.id)
          ? {
              ...job,
              stage: 'cancelled' as const,
              progress: null,
              message: 'Abgebrochen',
              finishedAt: new Date().toISOString(),
            }
          : job
      )
    );
  }, []);

  const clearFinished = useCallback(() => {
    setJobs((current) =>
      current.filter((job) => !['done', 'failed', 'cancelled'].includes(job.stage))
    );
  }, []);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    []
  );

  const activeCount = jobs.filter((job) =>
    ['queued', 'fetching', 'downloading', 'transcribing', 'analysing', 'extracting', 'writing'].includes(
      job.stage
    )
  ).length;

  return { jobs, enqueue, cancel, cancelAll, retry, clearFinished, activeCount };
}
