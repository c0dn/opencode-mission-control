import type { SessionSearchMatch } from "../types.js"

import { compareSearchMatches, getMatchKey } from "./lexical.js"

const DEFAULT_RRF_K = 60

export const fuseHybridMatchesRrf = (
  lexicalMatches: SessionSearchMatch[],
  semanticMatches: SessionSearchMatch[],
  k = DEFAULT_RRF_K,
) => {
  const fused = new Map<string, SessionSearchMatch>()

  addRankedMatches(fused, lexicalMatches, k)
  addRankedMatches(fused, semanticMatches, k)

  return Array.from(fused.values()).sort(compareSearchMatches)
}

const addRankedMatches = (
  fused: Map<string, SessionSearchMatch>,
  matches: SessionSearchMatch[],
  k: number,
) => {
  for (const [index, match] of matches.entries()) {
    const key = getMatchKey(match)
    const previous = fused.get(key)
    const contribution = 1 / (k + index + 1)

    if (!previous) {
      fused.set(key, {
        ...match,
        score: contribution,
      })
      continue
    }

    fused.set(key, {
      ...previous,
      matchType: previous.matchType === "exact" || match.matchType === "exact" ? "exact" : "candidate",
      score: previous.score + contribution,
    })
  }
}
