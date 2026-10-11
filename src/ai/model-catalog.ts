import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';

export const reasoningEfforts = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export type ReasoningEffort = 'auto' | (typeof reasoningEfforts)[number];
export interface GenerationOptions {
  model?: unknown;
  reasoningEffort?: unknown;
}
export interface GenerationSettings {
  model: string;
  reasoningEffort: ReasoningEffort;
  tokenParameter: 'max_tokens' | 'max_completion_tokens';
}
interface ModelDefinition {
  id: string;
  label: string;
  description: string;
  reasoningEfforts: (typeof reasoningEfforts)[number][];
  defaultEffort: ReasoningEffort;
  tokenParameter: GenerationSettings['tokenParameter'];
}

export function modelCatalog(defaultModel: string): ModelDefinition[] {
  if (!process.env.AI_MODELS?.trim())
    return [
      {
        id: defaultModel,
        label: defaultModel,
        description: '',
        reasoningEfforts: [],
        defaultEffort: 'auto',
        tokenParameter: 'max_tokens',
      },
    ];
  try {
    const values: unknown = JSON.parse(process.env.AI_MODELS);
    if (!Array.isArray(values) || !values.length || values.length > 30)
      throw new Error();
    const seen = new Set<string>();
    const models = values.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error();
      const {
        id,
        label = id,
        description = '',
        reasoningEfforts: efforts = [],
        defaultEffort = 'auto',
        tokenParameter = 'max_tokens',
      } = value;
      if (
        typeof id !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(id) ||
        seen.has(id) ||
        typeof label !== 'string' ||
        !label.trim() ||
        label.length > 80 ||
        typeof description !== 'string' ||
        description.length > 160 ||
        !Array.isArray(efforts) ||
        efforts.some((effort) => !reasoningEfforts.includes(effort)) ||
        new Set(efforts).size !== efforts.length ||
        (defaultEffort !== 'auto' && !efforts.includes(defaultEffort)) ||
        !['max_tokens', 'max_completion_tokens'].includes(tokenParameter)
      )
        throw new Error();
      seen.add(id);
      return {
        id,
        label,
        description,
        reasoningEfforts: reasoningEfforts.filter((effort) =>
          efforts.includes(effort),
        ),
        defaultEffort,
        tokenParameter,
      } as ModelDefinition;
    });
    if (!seen.has(defaultModel)) throw new Error();
    return models;
  } catch {
    throw new ServiceUnavailableException(
      'AI_MODELS 配置无效，请检查模型及思考档次配置',
    );
  }
}

export function resolveGeneration(
  defaultModel: string,
  options: GenerationOptions = {},
): GenerationSettings {
  if (
    options.model !== undefined &&
    (typeof options.model !== 'string' || !options.model)
  )
    throw new BadRequestException('model 必须是有效的模型 ID');
  if (
    options.reasoningEffort !== undefined &&
    typeof options.reasoningEffort !== 'string'
  )
    throw new BadRequestException('reasoningEffort 必须是有效思考档次');
  const model = modelCatalog(defaultModel).find(
    (item) => item.id === (options.model ?? defaultModel),
  );
  if (!model)
    throw new BadRequestException('所选模型不可用，请刷新模型列表后重试');
  const effort = options.reasoningEffort ?? model.defaultEffort;
  if (
    typeof effort !== 'string' ||
    (effort !== 'auto' &&
      !model.reasoningEfforts.includes(
        effort as (typeof reasoningEfforts)[number],
      ))
  )
    throw new BadRequestException('当前模型不支持所选思考档次');
  return {
    model: model.id,
    reasoningEffort: effort as ReasoningEffort,
    tokenParameter: model.tokenParameter,
  };
}
