/**
 * The transport to the engine, and the two things worth caching.
 *
 * Connecting is deferred until the first question is asked. An MCP client
 * expects `initialize` to come back promptly, and starting PoB is several
 * seconds of reading game data, so doing it eagerly would look like a server
 * that hangs on startup.
 */

import { connect, type Engine, EngineFailure } from './engine.js';
import type { TreeNode, TreeSnapshot } from './bridge-types.js';

/** Long, because a stat sort runs the engine against the whole database. */
const REQUEST_TIMEOUT_MS = 300_000;

export class BridgeError extends Error {}

/** The engine an error was about, for a notice that names what was lost. */
function engineOf(message: string): string {
  return /(http:\/\/\S+?)(?= did not answer)/.exec(message)?.[1] ?? 'the engine';
}

/**
 * The engine we were talking to is not answering its port.
 *
 * Private, because it never leaves this file: it is the one failure worth
 * reconnecting over, and a caller that saw it would only be told the same
 * thing again after the retry.
 */
class Gone extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
  }
}

export class Bridge {
  private engine: Engine | null = null;
  private connecting: Promise<Engine> | null = null;
  private nodes: Map<number, TreeNode> | null = null;
  private claimed = false;
  /**
   * A word owed to whoever asks next, because the engine changed.
   *
   * Reconnecting is the right thing to do and the wrong thing to do
   * quietly. A later answer is about a different process: the crafting
   * bench there is empty, and anything equipped on the old engine went
   * with it. Held here until something says it, rather than being logged
   * where only the terminal would see it.
   */
  private swapped: string | null = null;
  private readonly own: boolean;

  constructor(options: { own?: boolean } = {}) {
    this.own = options.own ?? false;
  }

  /** The engine, started if this is the first question. */
  private async ready(): Promise<Engine> {
    if (this.engine) return this.engine;
    // Several tool calls can arrive before the first one has an engine, and
    // they must queue behind one attempt rather than each starting PoB.
    this.connecting ??= connect({ own: this.own })
      .then((engine) => {
        this.engine = engine;
        return engine;
      })
      .catch((error: unknown) => {
        this.connecting = null;
        throw error;
      });
    return this.connecting;
  }

  /**
   * Forget the engine, so the next question goes looking for one again.
   *
   * Everything cached here belongs to the engine it came from. The bench
   * claim is about an item in that process memory, and the tree came out of
   * that process game data, so a different engine shares none of it and
   * keeping any of it would be answering about a build that is not there.
   */
  private forget() {
    this.engine = null;
    this.connecting = null;
    this.nodes = null;
    this.claimed = false;
  }

  /** Whether this process started the engine, so nothing else is watching it. */
  async ours(): Promise<boolean> {
    return (await this.ready()).ours;
  }

  /**
   * Whether the item on the crafting bench is one we put there.
   *
   * The guard on changing it exists to protect somebody else's work, so it
   * should fire when there is work to lose and not otherwise. An engine
   * this server started has nobody looking at it. An engine it attached to
   * might, unless what is on the bench is what we staged.
   *
   * A heuristic, and it says so in the tool that asks: the app could have
   * put something else on the bench between two of our calls and nothing
   * here would know.
   */
  async benchIsOurs(): Promise<boolean> {
    return this.claimed || (await this.ready()).ours;
  }

  /**
   * The engine-changed notice, said once.
   *
   * Taken rather than read, because it describes a transition and not a
   * state. Repeating it on every answer afterwards would make it noise,
   * and noise is how a warning stops being read.
   */
  takeNotice(): string | null {
    const notice = this.swapped;
    this.swapped = null;
    return notice;
  }

  claimBench() {
    this.claimed = true;
  }

  releaseBench() {
    this.claimed = false;
  }

  async get<T>(route: string, params: Record<string, string | number | undefined> = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') query.set(key, String(value));
    }
    const suffix = query.size > 0 ? `?${query}` : '';
    return this.request<T>(route + suffix);
  }

  async post<T>(route: string, body: unknown) {
    return this.request<T>(route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  }

  /**
   * Ask the engine, and look again if the engine has gone.
   *
   * An engine ends for ordinary reasons: somebody closes the app, or
   * restarts the dev server, or the engine follows the host that started
   * it. The port file already names whatever replaced it. Holding on to a
   * dead engine for the rest of this process turns one restart into every
   * later call failing, with a message about a port that stopped meaning
   * anything some time ago.
   *
   * Only one retry, and only when nothing was listening. A connection
   * refused is proof the request was never received, so repeating it
   * cannot repeat anything. A connection that dies mid-request is not: the
   * engine may have acted on it already, and this is the transport for
   * `POST /action`, so a blind retry there could equip an item twice. A
   * GET is safe either way, being a question.
   */
  private async request<T>(route: string, init?: RequestInit): Promise<T> {
    try {
      return await this.attempt<T>(route, init);
    } catch (error) {
      if (!(error instanceof Gone)) throw error;
      const replayable = init?.method !== 'POST' || error.code === 'ECONNREFUSED';
      if (!replayable) {
        this.forget();
        throw new BridgeError(
          `${error.message}. The request may or may not have been carried out, ` +
            'so it was not sent again. Ask what the build looks like now.',
        );
      }
      const lost = engineOf(error.message);
      this.forget();
      try {
        const answer = await this.attempt<T>(route, init);
        this.swapped =
          `Note: the engine changed. ${lost} stopped answering, and this is a ` +
          `different engine on ${this.engine?.base ?? 'another port'}. Anything ` +
          'staged on the crafting bench, or equipped but not saved, belonged to ' +
          'the engine that has gone. Check the build before relying on what an ' +
          'earlier answer said about it.';
        return answer;
      } catch (again) {
        if (!(again instanceof Gone)) throw again;
        throw new BridgeError(
          `${again.message}. That was a second attempt, against a freshly ` +
            'located engine, so there is probably no engine running.',
        );
      }
    }
  }

  private async attempt<T>(route: string, init?: RequestInit): Promise<T> {
    const engine = await this.ready();
    let response: Response;
    try {
      response = await fetch(engine.base + route, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
      const said = typeof code === 'string' ? code : undefined;
      // A timeout is the engine thinking, not the engine missing, and the
      // budget here is five minutes. Reconnecting over one would throw away
      // a working engine and spend another five minutes proving it.
      // Checked by name rather than by type: the timeout arrives as a
      // DOMException, whose relationship to Error is not worth relying on.
      const name = (error as { name?: unknown } | null)?.name;
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      const message = `the engine on ${engine.base} did not answer: ${reason}`;
      if (timedOut) throw new BridgeError(message);
      throw new Gone(message, said);
    }

    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const detail =
        body && typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : `${response.status} ${response.statusText}`;
      throw new BridgeError(detail);
    }
    return body as T;
  }

  /**
   * The passive tree, by node id.
   *
   * About 420 kB and 4,500 nodes, fetched once because its geometry never
   * changes. None of it is ever handed to a model: it is here so that a list
   * of allocated node ids can be turned into names, and so a name can be
   * turned back into the id the what-if routes want.
   */
  async treeNodes(): Promise<Map<number, TreeNode>> {
    if (this.nodes) return this.nodes;
    const tree = await this.get<TreeSnapshot>('/tree');
    if (!tree.ready) {
      throw new BridgeError('the engine has no passive tree loaded.');
    }
    const nodes = new Map<number, TreeNode>();
    for (const node of tree.nodes) nodes.set(node.id, node);
    this.nodes = nodes;
    return nodes;
  }

  stop() {
    this.engine?.stop();
  }
}

export { EngineFailure };
