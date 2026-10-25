import { Command } from 'commander';
import {
  createDb,
  createLogger,
  DbEvidenceStore,
  loadConfig,
  type CommandContext,
  type CommandSpec,
  type Db,
  type EvidenceStore,
  type Fetcher,
  type PackageModule,
  type PpConfig,
} from '@pp/core';

export interface ProgramHandle {
  program: Command;
  /** Closes anything the command context opened (database pool). */
  close(): Promise<void>;
}

export function collectCommands(modules: PackageModule[]): { spec: CommandSpec; pkg: string }[] {
  const seen = new Map<string, string>();
  const out: { spec: CommandSpec; pkg: string }[] = [];
  for (const m of modules) {
    for (const spec of m.commands) {
      const prior = seen.get(spec.name);
      if (prior !== undefined) {
        throw new Error(`Duplicate command "${spec.name}" registered by packages "${prior}" and "${m.name}"`);
      }
      seen.set(spec.name, m.name);
      out.push({ spec, pkg: m.name });
    }
  }
  return out;
}

export function buildProgram(
  modules: PackageModule[],
  deps: { out?: (line: string) => void; makeFetcher?: (config: PpConfig, db: Db | null) => Fetcher } = {},
): ProgramHandle {
  const specs = collectCommands(modules);
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const log = createLogger('pp');

  let config: PpConfig | null = null;
  let dbHandle: ReturnType<typeof createDb> | null = null;
  let fetcher: Fetcher | null = null;

  const ctx: CommandContext = {
    config() {
      config ??= loadConfig();
      return config;
    },
    async db(): Promise<Db> {
      dbHandle ??= createDb();
      return dbHandle.db;
    },
    async fetcher(): Promise<Fetcher> {
      if (!fetcher) {
        if (!deps.makeFetcher) throw new Error('no fetcher factory configured');
        const cfg = ctx.config();
        fetcher = deps.makeFetcher(cfg, process.env.DATABASE_URL ? await ctx.db() : null);
      }
      return fetcher;
    },
    async evidence(): Promise<EvidenceStore> {
      return new DbEvidenceStore(await ctx.db());
    },
    log,
    out,
    moduleNames: modules.map((m) => m.name),
  };

  const program = new Command('pp').description('Painter Promotions lead finder').exitOverride();
  program.configureOutput({ writeOut: (s) => process.stdout.write(s), writeErr: (s) => process.stderr.write(s) });

  for (const { spec } of specs) {
    const parts = spec.name.split(' ').filter((p) => p.length > 0);
    const leaf = parts.pop();
    if (!leaf) throw new Error(`Command with empty name from ${spec.description}`);
    let parent = program;
    for (const part of parts) {
      let next = parent.commands.find((c) => c.name() === part);
      if (!next) next = parent.command(part).description(`${part} commands`);
      parent = next;
    }
    const cmd = parent.command(leaf).description(spec.description);
    for (const a of spec.args ?? []) {
      const inner = a.variadic ? `${a.name}...` : a.name;
      cmd.argument(a.required ? `<${inner}>` : `[${inner}]`, a.description);
    }
    for (const o of spec.options ?? []) {
      if (o.defaultValue === undefined) cmd.option(o.flags, o.description);
      else cmd.option(o.flags, o.description, o.defaultValue);
    }
    cmd.action(async (...actionArgs: unknown[]) => {
      const command = actionArgs[actionArgs.length - 1] as Command;
      const code = await spec.run(ctx, [...command.args], command.opts());
      if (typeof code === 'number') process.exitCode = code;
    });
  }

  return {
    program,
    async close() {
      if (dbHandle) await dbHandle.close();
      dbHandle = null;
    },
  };
}
