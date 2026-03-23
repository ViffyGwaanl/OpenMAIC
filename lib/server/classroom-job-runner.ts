import { createLogger } from '@/lib/logger';
import { generateClassroom, type GenerateClassroomInput } from '@/lib/server/classroom-generation';
import {
  markClassroomGenerationJobFailed,
  markClassroomGenerationJobRunning,
  markClassroomGenerationJobSucceeded,
  updateClassroomGenerationJobProgress,
} from '@/lib/server/classroom-job-store';

const log = createLogger('ClassroomJob');
const runningJobs = new Map<string, Promise<void>>();

export function runClassroomGenerationJob(
  jobId: string,
  input: GenerateClassroomInput,
  baseUrl: string,
): Promise<void> {
  const existing = runningJobs.get(jobId);
  if (existing) {
    return existing;
  }

  const jobPromise = (async () => {
    try {
      await markClassroomGenerationJobRunning(jobId);

      const result = await generateClassroom(input, {
        baseUrl,
        onProgress: async (progress) => {
          await updateClassroomGenerationJobProgress(jobId, progress);
        },
      });

      await markClassroomGenerationJobSucceeded(jobId, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      const isRecord = (v: unknown): v is Record<string, unknown> =>
        typeof v === 'object' && v !== null;
      const getString = (o: Record<string, unknown>, k: string): string | undefined => {
        const v = o[k];
        return typeof v === 'string' ? v : undefined;
      };
      const getNumber = (o: Record<string, unknown>, k: string): number | undefined => {
        const v = o[k];
        return typeof v === 'number' ? v : undefined;
      };

      const errObj = isRecord(error) ? error : null;
      const lastErrObj = errObj && isRecord(errObj['lastError']) ? (errObj['lastError'] as Record<string, unknown>) : null;

      const errorDetails = {
        name: errObj ? getString(errObj, 'name') : undefined,
        message,
        reason: errObj ? getString(errObj, 'reason') : undefined,
        lastError: lastErrObj
          ? {
              name: getString(lastErrObj, 'name'),
              message: getString(lastErrObj, 'message'),
              statusCode: getNumber(lastErrObj, 'statusCode'),
              responseBodyPreview:
                typeof lastErrObj['responseBody'] === 'string'
                  ? (lastErrObj['responseBody'] as string).slice(0, 800)
                  : undefined,
            }
          : undefined,
      };

      // Log a compact structured error so we can root-cause "openai_error" instead of guessing.
      log.error(`Classroom generation job ${jobId} failed: ${message}`);
      if (errorDetails.name || errorDetails.reason || errorDetails.lastError) {
        log.error('Classroom job errorDetails:', errorDetails);
      }

      try {
        await markClassroomGenerationJobFailed(jobId, message, errorDetails);
      } catch (markFailedError) {
        log.error(`Failed to persist failed status for job ${jobId}:`, markFailedError);
      }
    } finally {
      runningJobs.delete(jobId);
    }
  })();

  runningJobs.set(jobId, jobPromise);
  return jobPromise;
}
