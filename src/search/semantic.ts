import { MissionControlIndexDB } from "../index-db.js"
import type { SearchIndexDocument } from "../index-db.js"
import type { SemanticEmbeddingProvider } from "../semantic-provider.js"
import { createSearchSnippet } from "../snippets.js"
import type { SessionChunk, SessionSearchMatch } from "../types.js"

import { dot, fingerprintText, trimSemanticQueryCache } from "./fingerprint.js"
import { compareSearchMatches } from "./lexical.js"

export async function ensureSemanticVectors(
  indexDB: MissionControlIndexDB,
  index: SearchIndexDocument,
  semanticProvider: SemanticEmbeddingProvider,
) {
  const signature = semanticProvider.signature()
  const existingSemantic = index.semantic
  const fingerprints = Object.fromEntries(index.chunks.map((chunk) => [chunk.chunkID, fingerprintText(chunk.text)]))
  const reusableVectors =
    existingSemantic?.signature === signature
      ? Object.fromEntries(
          index.chunks
            .map(
              (chunk) =>
                [
                  chunk.chunkID,
                  existingSemantic.vectors[chunk.chunkID],
                  existingSemantic.fingerprints[chunk.chunkID],
                  fingerprints[chunk.chunkID],
                ] as const,
            )
            .filter(
              (entry): entry is readonly [string, number[], string, string] =>
                Array.isArray(entry[1]) && entry[1].length > 0 && entry[2] === entry[3],
            )
            .map(([chunkID, vector]) => [chunkID, vector] as const),
        )
      : {}
  const requiresSemanticPrune =
    existingSemantic?.signature === signature &&
    (Object.keys(existingSemantic.vectors).length !== Object.keys(reusableVectors).length ||
      Object.keys(existingSemantic.fingerprints).length !== Object.keys(fingerprints).length)

  if (existingSemantic?.signature === signature && Object.keys(reusableVectors).length === index.chunks.length) {
    if (!requiresSemanticPrune) {
      return index
    }

    return indexDB.save({
      ...index,
      semantic: {
        ...existingSemantic,
        fingerprints,
        vectors: reusableVectors,
        queries: existingSemantic.queries ?? {},
      },
    })
  }

  const missingChunks = index.chunks.filter((chunk) => !Array.isArray(reusableVectors[chunk.chunkID]))
  const embeddings = await semanticProvider.embedPassages(missingChunks.map((chunk) => chunk.text))
  if (embeddings.length !== missingChunks.length) {
    throw new Error("Semantic provider did not return one embedding per missing indexed chunk")
  }

  const vectors = {
    ...reusableVectors,
    ...Object.fromEntries(missingChunks.map((chunk, index) => [chunk.chunkID, embeddings[index] ?? []])),
  }
  const nextIndex = {
    ...index,
    semantic: {
      signature,
      builtAt: Date.now(),
      fingerprints,
      vectors,
      queries: existingSemantic?.signature === signature ? existingSemantic.queries ?? {} : {},
    },
  }

  return indexDB.save(nextIndex)
}

export async function ensureSemanticQueryVector(
  indexDB: MissionControlIndexDB,
  index: SearchIndexDocument,
  semanticProvider: SemanticEmbeddingProvider,
  query: string,
) {
  const signature = semanticProvider.signature()
  const semantic = index.semantic
  const queryKey = `query:${fingerprintText(query)}`
  const existingQuery = semantic?.signature === signature ? semantic.queries?.[queryKey] : undefined

  if (existingQuery?.text === query && Array.isArray(existingQuery.vector) && existingQuery.vector.length > 0) {
    if (semantic) {
      const nextIndex: SearchIndexDocument = {
        ...index,
        semantic: {
          ...semantic,
          queries: {
            ...(semantic.queries ?? {}),
            [queryKey]: {
              ...existingQuery,
              updatedAt: Date.now(),
            },
          },
        },
      }

      return {
        index: await indexDB.save(nextIndex),
        vector: existingQuery.vector,
      }
    }

    return {
      index,
      vector: existingQuery.vector,
    }
  }

  const vector = await semanticProvider.embedQuery(query)
  if (!semantic || semantic.signature !== signature) {
    return {
      index,
      vector,
    }
  }

  const nextIndex: SearchIndexDocument = {
    ...index,
    semantic: {
      ...semantic,
      queries: trimSemanticQueryCache({
        ...(semantic.queries ?? {}),
        [queryKey]: {
          text: query,
          vector,
          updatedAt: Date.now(),
        },
      }),
    },
  }

  return {
    index: await indexDB.save(nextIndex),
    vector,
  }
}

export function scoreSemantically(
  chunks: SessionChunk[],
  sessionMap: Map<string, { title: string }>,
  vectors: Record<string, number[]>,
  queryVector: number[],
  query: string,
): SessionSearchMatch[] {
  if (chunks.length === 0 || queryVector.length === 0) {
    return []
  }

  const matches: SessionSearchMatch[] = []

  for (const chunk of chunks) {
    const vector = vectors[chunk.chunkID]
    if (!Array.isArray(vector) || vector.length === 0) {
      continue
    }

    matches.push({
      sessionId: chunk.sessionID,
      messageId: chunk.messageID,
      partId: chunk.partID,
      score: dot(queryVector, vector),
      matchType: "candidate",
      title: sessionMap.get(chunk.sessionID)?.title,
      snippet: createSearchSnippet(chunk.text, query),
      role: chunk.role,
      partType: chunk.partType,
      createdAt: chunk.createdAt,
    })
  }

  return matches.sort(compareSearchMatches)
}

export function buildSemanticCandidateMatches(
  candidates: { chunkID: string; score: number }[],
  chunksByID: Map<string, SessionChunk>,
  sessionMap: Map<string, { title: string }>,
  query: string,
): SessionSearchMatch[] {
  return candidates
    .map((candidate) => {
      const chunk = chunksByID.get(candidate.chunkID)
      if (!chunk) {
        return undefined
      }

      const match: SessionSearchMatch = {
        sessionId: chunk.sessionID,
        messageId: chunk.messageID,
        partId: chunk.partID,
        score: candidate.score,
        matchType: "candidate",
        title: sessionMap.get(chunk.sessionID)?.title,
        snippet: createSearchSnippet(chunk.text, query),
        role: chunk.role,
        partType: chunk.partType,
        createdAt: chunk.createdAt,
      }
      return match
    })
    .filter((match): match is SessionSearchMatch => Boolean(match))
    .sort(compareSearchMatches)
}
