import { nanoid } from 'nanoid';
import { callLLM } from '@/lib/ai/llm';
import { createStageAPI } from '@/lib/api/stage-api';
import type { StageStore } from '@/lib/api/stage-api-types';
import {
  applyOutlineFallbacks,
  generateSceneOutlinesFromRequirements,
} from '@/lib/generation/outline-generator';
import {
  createSceneWithActions,
  generateSceneActions,
  generateSceneContent,
} from '@/lib/generation/scene-generator';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import { createLogger } from '@/lib/logger';
import { parseModelString } from '@/lib/ai/providers';
import { resolveApiKey } from '@/lib/server/provider-config';
import { resolveModel } from '@/lib/server/resolve-model';
import { persistClassroom } from '@/lib/server/classroom-storage';
import type { UserRequirements } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';

const log = createLogger('Classroom');

export interface GenerateClassroomInput {
  requirement: string;
  pdfContent?: { text: string; images: string[] };
  language?: string;
}

export type ClassroomGenerationStep =
  | 'initializing'
  | 'generating_outlines'
  | 'generating_scenes'
  | 'persisting'
  | 'completed';

export interface ClassroomGenerationProgress {
  step: ClassroomGenerationStep;
  progress: number;
  message: string;
  scenesGenerated: number;
  totalScenes?: number;
}

export interface GenerateClassroomResult {
  id: string;
  url: string;
  stage: Stage;
  scenes: Scene[];
  scenesCount: number;
  createdAt: string;
}

function createInMemoryStore(stage: Stage): StageStore {
  let state = {
    stage: stage as Stage | null,
    scenes: [] as Scene[],
    currentSceneId: null as string | null,
    mode: 'playback' as const,
  };

  const listeners: Array<(s: typeof state, prev: typeof state) => void> = [];

  return {
    getState: () => state,
    setState: (partial: Partial<typeof state>) => {
      const prev = state;
      state = { ...state, ...partial };
      listeners.forEach((fn) => fn(state, prev));
    },
    subscribe: (listener: (s: typeof state, prev: typeof state) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
  };
}

function normalizeLanguage(language?: string): 'zh-CN' | 'en-US' {
  return language === 'en-US' ? 'en-US' : 'zh-CN';
}

export async function generateClassroom(
  input: GenerateClassroomInput,
  options: {
    baseUrl: string;
    onProgress?: (progress: ClassroomGenerationProgress) => Promise<void> | void;
  },
): Promise<GenerateClassroomResult> {
  const { requirement, pdfContent } = input;

  await options.onProgress?.({
    step: 'initializing',
    progress: 5,
    message: 'Initializing classroom generation',
    scenesGenerated: 0,
  });

  const { model: languageModel, modelInfo, modelString } = resolveModel({});
  log.info(`Using server-configured model: ${modelString}`);

  // Fail fast if the resolved provider has no API key configured
  const { providerId } = parseModelString(modelString);
  const apiKey = resolveApiKey(providerId);
  if (!apiKey) {
    throw new Error(
      `No API key configured for provider "${providerId}". ` +
        `Set the appropriate key in .env.local or server-providers.yml (e.g. ${providerId.toUpperCase()}_API_KEY).`,
    );
  }

  const aiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
    const result = await callLLM(
      {
        model: languageModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        maxOutputTokens: modelInfo?.outputWindow,
      },
      'generate-classroom',
    );
    return result.text;
  };

  const lang = normalizeLanguage(input.language);
  const requirements: UserRequirements = {
    requirement,
    language: lang,
  };
  const pdfText = pdfContent?.text || undefined;

  await options.onProgress?.({
    step: 'generating_outlines',
    progress: 15,
    message: 'Generating scene outlines',
    scenesGenerated: 0,
  });

  const outlinesResult = await generateSceneOutlinesFromRequirements(
    requirements,
    pdfText,
    undefined,
    aiCall,
  );

  if (!outlinesResult.success || !outlinesResult.data) {
    log.error('Failed to generate outlines:', outlinesResult.error);
    throw new Error(outlinesResult.error || 'Failed to generate scene outlines');
  }

  const outlines = outlinesResult.data;
  log.info(`Generated ${outlines.length} scene outlines`);

  await options.onProgress?.({
    step: 'generating_outlines',
    progress: 30,
    message: `Generated ${outlines.length} scene outlines`,
    scenesGenerated: 0,
    totalScenes: outlines.length,
  });

  const stageId = nanoid(10);
  const stage: Stage = {
    id: stageId,
    name: outlines[0]?.title || requirement.slice(0, 50),
    description: undefined,
    language: lang,
    style: 'interactive',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const store = createInMemoryStore(stage);
  const api = createStageAPI(store);

  log.info('Stage 2: Generating scene content and actions...');

  const totalScenes = outlines.length;
  const concurrency = Math.max(1, Number.parseInt(process.env.CLASSROOM_SCENE_CONCURRENCY || '3', 10) || 3);
  const seedCount = Math.max(0, Number.parseInt(process.env.CLASSROOM_SCENE_SEED_COUNT || '2', 10) || 2);
  const effectiveSeedCount = Math.min(seedCount, totalScenes);

  // A compact course plan to keep later scenes aligned with earlier ones.
  const coursePlan = outlines
    .map((o, i) => {
      const points = (o.keyPoints || []).slice(0, 4).map((p) => `- ${p}`).join('\n');
      return `Scene ${i + 1}: ${o.title}\n${points}`;
    })
    .join('\n\n');

  function buildContinuityContext(sceneIndex: number): string {
    const prev = outlines
      .slice(Math.max(0, sceneIndex - 4), sceneIndex)
      .map((o, i) => {
        const idx = Math.max(0, sceneIndex - 4) + i + 1;
        const points = (o.keyPoints || []).slice(0, 3).map((p) => `- ${p}`).join('\n');
        return `Previously covered (Scene ${idx}): ${o.title}\n${points}`;
      })
      .join('\n\n');

    return [
      'Course plan (for consistency, do not contradict it):',
      coursePlan,
      prev ? `\n\n${prev}` : '',
      '\n\nRules:',
      '- Keep terminology/definitions consistent across scenes.',
      '- Do not assume concepts that were not introduced in earlier scenes.',
      '- Avoid repeating large chunks from earlier scenes.',
    ].join('\n');
  }

  const results: Array<{
    index: number;
    outlineTitle: string;
    outline: ReturnType<typeof applyOutlineFallbacks>;
    content: Awaited<ReturnType<typeof generateSceneContent>> | null;
    actions: Awaited<ReturnType<typeof generateSceneActions>> | null;
  }> = [];

  let completed = 0;
  async function generateOne(index: number) {
    const safeOutline = applyOutlineFallbacks(outlines[index]!, true);

    const continuity = buildContinuityContext(index);
    const wrappedAiCall: AICallFn = async (systemPrompt, userPrompt, images) => {
      return aiCall(systemPrompt, `${userPrompt}\n\n---\n${continuity}`, images);
    };

    const content = await generateSceneContent(safeOutline, wrappedAiCall);
    if (!content) {
      return { index, outlineTitle: safeOutline.title, outline: safeOutline, content: null, actions: null };
    }
    const actions = await generateSceneActions(safeOutline, content, wrappedAiCall);
    return { index, outlineTitle: safeOutline.title, outline: safeOutline, content, actions };
  }

  // Simple concurrency-limited mapper (no extra dependency).
  async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
    const queue = [...items];
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (item === undefined) return;
        await fn(item);
      }
    });
    await Promise.all(workers);
  }

  // Seed a few early scenes sequentially (best coherence), then parallelize the rest.
  for (let i = 0; i < effectiveSeedCount; i += 1) {
    await options.onProgress?.({
      step: 'generating_scenes',
      progress: 31,
      message: `Generating seed scene ${i + 1}/${totalScenes}: ${outlines[i]!.title}`,
      scenesGenerated: completed,
      totalScenes,
    });

    const r = await generateOne(i);
    results.push(r);
    completed += 1;

    await options.onProgress?.({
      step: 'generating_scenes',
      progress: 30 + Math.floor((completed / Math.max(totalScenes, 1)) * 60),
      message: `Generated ${completed}/${totalScenes} scenes (seed)` ,
      scenesGenerated: completed,
      totalScenes,
    });
  }

  const remaining = Array.from({ length: totalScenes - effectiveSeedCount }, (_, k) => k + effectiveSeedCount);

  await options.onProgress?.({
    step: 'generating_scenes',
    progress: 40,
    message: `Generating remaining scenes with concurrency=${concurrency}`,
    scenesGenerated: completed,
    totalScenes,
  });

  await mapWithConcurrency<number>(remaining, concurrency, async (idx) => {
    const r = await generateOne(idx);
    results.push(r);
    completed += 1;

    await options.onProgress?.({
      step: 'generating_scenes',
      progress: 30 + Math.floor((completed / Math.max(totalScenes, 1)) * 60),
      message: `Generated ${Math.min(completed, totalScenes)}/${totalScenes} scenes`,
      scenesGenerated: Math.min(completed, totalScenes),
      totalScenes,
    });
  });

  // Persist scenes in outline order to keep player navigation stable.
  let _generatedScenes = 0;
  for (const r of results.sort((a, b) => a.index - b.index)) {
    if (!r.content || !r.actions) {
      log.warn(`Skipping scene "${r.outlineTitle}" — generation failed`);
      continue;
    }

    log.info(`Scene "${r.outlineTitle}": ${r.actions.length} actions`);
    const sceneId = createSceneWithActions(r.outline, r.content, r.actions, api);
    if (!sceneId) {
      log.warn(`Skipping scene "${r.outlineTitle}" — scene creation failed`);
      continue;
    }

    _generatedScenes += 1;
  }

  const scenes = store.getState().scenes;
  log.info(`Pipeline complete: ${scenes.length} scenes generated`);

  if (scenes.length === 0) {
    throw new Error('No scenes were generated');
  }

  await options.onProgress?.({
    step: 'persisting',
    progress: 95,
    message: 'Persisting classroom data',
    scenesGenerated: scenes.length,
    totalScenes: outlines.length,
  });

  const persisted = await persistClassroom(
    {
      id: stageId,
      stage,
      scenes,
    },
    options.baseUrl,
  );

  log.info(`Classroom persisted: ${persisted.id}, URL: ${persisted.url}`);

  await options.onProgress?.({
    step: 'completed',
    progress: 100,
    message: 'Classroom generation completed',
    scenesGenerated: scenes.length,
    totalScenes: outlines.length,
  });

  return {
    id: persisted.id,
    url: persisted.url,
    stage,
    scenes,
    scenesCount: scenes.length,
    createdAt: persisted.createdAt,
  };
}
