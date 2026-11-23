// The tsserver plugin: a function's tests, in its hover and after calls to it.
// The editor extension contributes it (`typescriptServerPlugins`), and its
// build bundles it into the extension's node_modules, where tsserver looks.
//
// Nothing here may break the language service: whatever goes wrong, the
// editor gets what TypeScript said, without the claims.
import { useTypeScript } from "./typescript.mts";
import { hoverClaims, rowHints } from "./claims.mts";

import type TS from "@typescript/typescript6";

type Logger = { info(message: string): void };

const guarded = <T,>(
  logger: Logger,
  what: string,
  run: () => T,
  fallback: T,
): T => {
  try {
    return run();
  } catch (error) {
    logger.info(
      `namespace-tests: ${what} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    return fallback;
  }
};

/** tsserver's entry point: handed its own TypeScript, it returns the plugin. */
export function init({ typescript }: { typescript: typeof TS }) {
  useTypeScript(typescript);
  return {
    create(info: TS.server.PluginCreateInfo): TS.LanguageService {
      const service = info.languageService;
      const logger = info.project.projectService.logger;
      const proxy = Object.create(null) as TS.LanguageService;
      for (const key of Object.keys(service) as (keyof TS.LanguageService)[]) {
        const member = service[key];
        // @ts-expect-error: each member is forwarded as it is, whatever its signature
        proxy[key] =
          typeof member === "function" ? member.bind(service) : member;
      }

      proxy.getQuickInfoAtPosition = (fileName, position, ...rest) => {
        const prior = service.getQuickInfoAtPosition(
          fileName,
          position,
          ...rest,
        );
        if (!prior) return prior;
        const program = service.getProgram();
        const claims = program
          ? guarded(
              logger,
              "hover",
              () => hoverClaims(program, fileName, position),
              null,
            )
          : null;
        return claims
          ? {
              ...prior,
              documentation: [
                ...(prior.documentation ?? []),
                { kind: "text", text: `\n\n${claims}` },
              ],
            }
          : prior;
      };

      proxy.provideInlayHints = (fileName, span, preferences, ...rest) => {
        const prior = service.provideInlayHints(
          fileName,
          span,
          preferences,
          ...rest,
        );
        const program = service.getProgram();
        if (!program) return prior;
        const ours = guarded(
          logger,
          "inlay hints",
          () => rowHints(program, fileName, span),
          [],
        );
        return [
          ...prior,
          ...ours.map((h) => ({
            text: h.text,
            position: h.position,
            kind: typescript.InlayHintKind.Type,
            whitespaceBefore: true,
          })),
        ];
      };

      return proxy;
    },
  };
}
