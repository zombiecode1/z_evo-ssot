declare module 'fastembed' {
  export const EmbeddingModel: {
    BGESmallENV15: string;
    CUSTOM: string;
    [key: string]: string;
  };

  export type EmbeddingModel = string;

  export type EmbeddingInstance = {
    queryEmbed(query: string): Promise<number[]>;
    passageEmbed(texts: string[], batchSize?: number): AsyncGenerator<number[][], void, unknown>;
  };

  export class FlagEmbedding {
    static init(opts: any): Promise<EmbeddingInstance>;
  }
}
