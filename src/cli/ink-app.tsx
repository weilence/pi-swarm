import { useCallback, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useInput } from "ink";
import { TextInput } from "./text-input.tsx";
import { Picker } from "./picker.tsx";
import { useLogStore, type LogStore } from "./log-store.ts";
import { executeCommand, type AgentController, type CommandServices, type CommandState, type ProviderCatalog, type TaskDispatcher } from "./commands.ts";
import type { PickerOption } from "./picker-logic.ts";
import type { ConfigurableModuleWorker } from "../core/worker.ts";
import type { ModuleDefinition } from "../protocol/contracts.ts";
import type { ModelsDevProvider } from "../models-dev/catalog.ts";

interface ActivePick {
  title: string;
  options: readonly PickerOption<unknown>[];
  resolve: (value: unknown) => void;
}

export interface InkAppProps {
  store: LogStore;
  agent: AgentController;
  worker?: ConfigurableModuleWorker;
  catalog: ProviderCatalog;
  supervisor: TaskDispatcher;
  module: ModuleDefinition;
  /** Provider restored from persisted config, so /model works right after startup. */
  initialProvider?: ModelsDevProvider;
  /** Model id restored from persisted config (bare id within initialProvider). */
  initialModelId?: string;
  onExit: () => void;
}

/** REPL shell: streaming log above, prompt at the bottom, picker popup on demand. */
export function InkApp({ store, agent, worker, catalog, supervisor, module, initialProvider, initialModelId, onExit }: InkAppProps) {
  const snapshot = useLogStore(store);
  const commandState = useRef<CommandState>({ taskNumber: 0, selectedProvider: initialProvider, selectedModelId: initialModelId });
  const [pick, setPick] = useState<ActivePick | null>(null);
  const [busy, setBusy] = useState(false);

  const pickValue = useCallback(
    async <T,>(title: string, options: readonly PickerOption<T>[]): Promise<T | undefined> => {
      return await new Promise<T | undefined>((resolve) => {
        setPick({
          title,
          options,
          resolve: (value: unknown) => {
            setPick(null);
            resolve(value as T | undefined);
          }
        });
      });
    },
    []
  );

  const services = useMemo<CommandServices>(
    () => ({
      agent,
      worker,
      catalog,
      supervisor,
      module,
      interactive: true,
      log: (line: string) => store.append(line),
      pick: pickValue
    }),
    [agent, worker, catalog, supervisor, module, store, pickValue]
  );

  const handleSubmit = useCallback(
    async (line: string) => {
      setBusy(true);
      try {
        const outcome = await executeCommand(line, services, commandState.current);
        if (outcome === "exit") onExit();
      } finally {
        setBusy(false);
      }
    },
    [services, onExit]
  );

  // While a task runs the prompt is suspended; keep Ctrl+C as an escape hatch.
  useInput(
    (_input, key) => {
      if (key.ctrl && _input === "c") onExit();
    },
    { isActive: busy && pick === null }
  );

  return (
    <Box flexDirection="column">
      <Static items={snapshot.lines}>{(line, index) => <Text key={index}>{line}</Text>}</Static>
      {snapshot.tail ? <Text>{snapshot.tail}</Text> : null}
      {pick ? (
        <Picker
          title={pick.title}
          options={pick.options}
          onSelect={(value) => pick.resolve(value)}
          onCancel={() => pick.resolve(undefined)}
        />
      ) : null}
      <Box>
        {busy && pick === null ? (
          <Text dimColor>⏳ 任务执行中（Ctrl+C 退出）…</Text>
        ) : (
          <TextInput onSubmit={handleSubmit} onExit={onExit} disabled={pick !== null} />
        )}
      </Box>
    </Box>
  );
}
