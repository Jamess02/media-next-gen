/**
 * Outils communs aux tests des connecteurs de marche.
 *
 * Aucun test de connecteur ne touche le reseau : ils testeraient la
 * disponibilite de Binance ou de Yahoo plutot que notre code, et echoueraient
 * hors ligne. Les charges utiles viennent de reponses REELLES, mesurees le
 * 2026-09-11 — pas de formes imaginees.
 */

import { vi } from "vitest";

import type { Horloge } from "../src/marche/acces.js";

/** 2026-09-11T08:00:00Z : la matinee d'une collecte. */
export const T0 = Date.parse("2026-09-11T08:00:00.000Z");
/** Reference des releves : minuit UTC du jour. */
export const MINUIT = new Date("2026-09-11T00:00:00.000Z");

export interface ReponseSimulee {
  status?: number;
  corps?: unknown;
  entetes?: Record<string, string>;
  erreur?: { name: string; message: string };
}

export interface AppelSimule {
  url: string;
  entetes: Record<string, string>;
}

/** Remplace `fetch` par une file de reponses ; rend les appels recus. */
export function stubReponses(reponses: ReponseSimulee[]): AppelSimule[] {
  const appels: AppelSimule[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      appels.push({
        url: String(url),
        entetes: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
      });
      const r = reponses.shift() ?? { status: 599, corps: { erreur: "file de reponses epuisee" } };
      if (r.erreur !== undefined) {
        const e = new Error(r.erreur.message);
        e.name = r.erreur.name;
        throw e;
      }
      const status = r.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(r.entetes ?? {}),
        body: null,
        text: async () => JSON.stringify(r.corps ?? {}),
      };
    }),
  );
  return appels;
}

/** Horloge factice : l'attente avance le temps au lieu de le consommer. */
export function horlogeFactice(debut = T0): { h: Horloge; etat: { t: number; attentes: number[] } } {
  const etat = { t: debut, attentes: [] as number[] };
  return {
    etat,
    h: {
      maintenant: () => etat.t,
      attendre: async (ms) => {
        etat.attentes.push(ms);
        etat.t += ms;
      },
      aleatoire: () => 0,
    },
  };
}
