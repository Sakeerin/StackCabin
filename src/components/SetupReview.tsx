import type { T } from "../lib/i18n";
import type { ProjectPlan } from "../lib/types";
import { commandText } from "../lib/project-plan";

export function SetupReview({
  plan,
  loading,
  error,
  t,
}: {
  plan: ProjectPlan | null;
  loading: boolean;
  error: string | null;
  t: T;
}) {
  return (
    <section className="setup-review" aria-label={t("reviewSetup")}>
      <h3>{t("reviewSetup")}</h3>
      {loading ? (
        <p role="status">{t("reviewLoading")}</p>
      ) : error ? (
        <p role="alert" className="error-text">
          {error}
        </p>
      ) : !plan ? (
        <p className="muted">{t("reviewNative")}</p>
      ) : (
        <>
          <p className="muted small">{t("reviewHelp")}</p>
          <h4>{t("runtime")}</h4>
          <ul className="review-runtimes">
            {plan.requirements.map((runtime) => (
              <li key={runtime.component}>
                <code>
                  {runtime.component} {runtime.version}
                </code>
                <span className={`tag ${runtime.installed ? "success" : ""}`}>
                  {!runtime.artifactId
                    ? t("reviewUnavailable")
                    : runtime.installed
                      ? t("installed")
                      : t("reviewDownload")}
                </span>
              </li>
            ))}
          </ul>
          {plan.requirements.some((r) => !r.artifactId) && (
            <p className="error-text">{t("reviewMissing")}</p>
          )}
          <h4>{t("reviewDependencies")}</h4>
          {!!plan.commands.length && (
            <p className="muted small">{t("reviewDirectory")}: .</p>
          )}
          {plan.commands.length ? (
            <ol className="review-commands">
              {plan.commands.map((command, index) => (
                <li key={index}>
                  <code>{commandText(command.tool, command.args)}</code>
                  {command.condition && (
                    <small>
                      {command.condition === "generated-lockfile"
                        ? t("reviewGeneratedLock")
                        : t("reviewGeneratedNoLock")}
                    </small>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted small">{t("reviewNoDependencies")}</p>
          )}
          {plan.commands.some((c) =>
            c.args.includes("${LARAVEL_DESTINATION}"),
          ) && <p className="muted small">{t("reviewLaravel")}</p>}
          <h4>{t("reviewProcesses")}</h4>
          <ul className="review-commands">
            {plan.processes.map((process) => (
              <li key={process.name}>
                <strong>{process.name}</strong>
                <code>
                  {process.tool === "static"
                    ? t("reviewStatic")
                    : process.tool === "php-web"
                      ? t("reviewPhp")
                      : commandText(process.tool, process.args)}
                </code>
                <small>
                  {t("reviewDirectory")}: {process.cwd}
                </small>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
