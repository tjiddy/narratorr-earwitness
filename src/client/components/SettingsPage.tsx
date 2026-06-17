import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConfigOverlay, SettingsResponse, WhisperBackendName } from '@shared/schemas.js';
import { getSettings, saveSettings, rotateKey, getStoredApiKey, setStoredApiKey } from '../api';
import { Button } from './Button';
import { FormField } from './FormField';
import { CopyIcon, RefreshIcon } from './icons';

const BACKENDS: WhisperBackendName[] = ['openai-compat', 'whispercpp', 'transformersjs'];
const inputClass = 'w-full px-4 py-3 bg-background border border-border rounded-xl focus-ring transition-all';

function Dot({ ok }: { ok: boolean }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${ok ? 'bg-success' : 'bg-destructive'}`} />;
}

export function SettingsPage() {
  const qc = useQueryClient();
  const [apiKeyInput, setApiKeyInput] = useState(getStoredApiKey());
  const settings = useQuery({ queryKey: ['settings'], queryFn: getSettings, retry: false });

  return (
    <div className="space-y-6">
      <ApiKeyCard apiKeyInput={apiKeyInput} setApiKeyInput={setApiKeyInput} serverKey={settings.data?.apiKey ?? null} />

      {settings.error && (
        <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Couldn’t load settings: {String((settings.error as Error).message)}. If you’re not on the server itself, enter the API key above and click “Use this key”.
        </p>
      )}

      {settings.data && (
        // key remounts the form (re-seeding its fields) only when the EFFECTIVE config
        // changes — i.e. after a save — never mid-edit (there's no polling). This is the
        // React-recommended alternative to syncing props into state via an effect.
        <SettingsForm
          key={`${settings.data.ollama.host}|${settings.data.ollama.model}|${settings.data.whisper.backend}|${settings.data.whisper.host}|${settings.data.whisper.model}`}
          data={settings.data}
          onSaved={() => void qc.invalidateQueries({ queryKey: ['settings'] })}
        />
      )}

      {settings.data && (
        <RotateKeyCard
          onRotated={(key) => {
            setStoredApiKey(key);
            setApiKeyInput(key);
            void qc.invalidateQueries();
          }}
        />
      )}
    </div>
  );
}

function ApiKeyCard({
  apiKeyInput,
  setApiKeyInput,
  serverKey,
}: {
  apiKeyInput: string;
  setApiKeyInput: (v: string) => void;
  serverKey: string | null;
}) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);

  const apply = () => {
    setStoredApiKey(apiKeyInput.trim());
    void qc.invalidateQueries(); // re-run every /api query with the new key
  };

  const copy = async () => {
    if (!serverKey) return;
    try {
      await navigator.clipboard.writeText(serverKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the field is selectable as a fallback */
    }
  };

  return (
    <div className="glass-card space-y-3 rounded-2xl p-4">
      <h2 className="font-display text-lg font-semibold">API key</h2>
      <p className="text-sm text-muted-foreground">
        earwitness gates its API on the network. This browser sends the key below with every request — set it once.
        (Requests from the server itself / loopback are trusted without a key.)
      </p>
      <div className="flex items-end gap-2">
        <FormField
          id="settings-apikey"
          label="API key for this browser"
          type="password"
          value={apiKeyInput}
          onChange={setApiKeyInput}
          placeholder="paste the key from /data/api-key or the server logs"
          className="flex-1"
        />
        <Button variant="primary" onClick={apply}>
          Use this key
        </Button>
      </div>
      {serverKey && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Server key:</span>
          <code className="min-w-0 flex-1 truncate rounded-lg bg-muted/50 px-2 py-1 font-mono text-xs">{serverKey}</code>
          <Button variant="ghost" size="sm" icon={CopyIcon} onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      )}
    </div>
  );
}

function SettingsForm({ data, onSaved }: { data: SettingsResponse; onSaved: () => void }) {
  const [ollamaHost, setOllamaHost] = useState(data.ollama.host ?? '');
  const [ollamaModel, setOllamaModel] = useState(data.ollama.model);
  const [whisperBackend, setWhisperBackend] = useState<WhisperBackendName>(data.whisper.backend as WhisperBackendName);
  const [whisperHost, setWhisperHost] = useState(data.whisper.host ?? '');
  const [whisperModel, setWhisperModel] = useState(data.whisper.model);

  const save = useMutation({
    mutationFn: () => {
      const overlay: ConfigOverlay = {
        ollama: { host: ollamaHost.trim(), model: ollamaModel.trim() },
        whisper: { backend: whisperBackend, host: whisperHost.trim(), model: whisperModel.trim() },
      };
      return saveSettings(overlay);
    },
    onSuccess: onSaved,
  });

  const transformersjs = whisperBackend === 'transformersjs';

  return (
    <div className="glass-card space-y-5 rounded-2xl p-4">
      <h2 className="font-display text-lg font-semibold">Engines</h2>

      <section className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Dot ok={data.ollama.reachable} /> Ollama (extraction LLM)
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField id="set-ollama-host" label="Host" type="url" value={ollamaHost} onChange={setOllamaHost} placeholder="http://localhost:11434" />
          <FormField id="set-ollama-model" label="Model" value={ollamaModel} onChange={setOllamaModel} placeholder="qwen2.5:7b-instruct" />
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Dot ok={data.whisper.reachable} /> Whisper (speech-to-text)
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="set-whisper-backend" className="block text-sm font-medium mb-2">
              Backend
            </label>
            <select
              id="set-whisper-backend"
              className={inputClass}
              value={whisperBackend}
              onChange={(e) => setWhisperBackend(e.target.value as WhisperBackendName)}
            >
              {BACKENDS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
          <FormField
            id="set-whisper-host"
            label="Host"
            type="url"
            value={whisperHost}
            onChange={setWhisperHost}
            disabled={transformersjs}
            placeholder="http://localhost:8000"
            hint={transformersjs ? 'in-process — no host needed' : undefined}
          />
          <FormField id="set-whisper-model" label="Model" value={whisperModel} onChange={setWhisperModel} placeholder="large-v3-turbo" />
        </div>
      </section>

      <div className="flex items-center gap-3">
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save changes'}
        </Button>
        {save.isSuccess && <span className="text-sm text-success">Saved — applied live.</span>}
        {save.error && <span className="text-sm text-destructive">{String((save.error as Error).message)}</span>}
      </div>
      <p className="text-xs text-muted-foreground">
        Stored in <code className="font-mono">config.json</code> next to the data dir and applied without a restart.
        Paths, ports, browse roots and the library root stay environment-only.
      </p>
    </div>
  );
}

function RotateKeyCard({ onRotated }: { onRotated: (key: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  const rotate = useMutation({
    mutationFn: rotateKey,
    onSuccess: (res) => {
      onRotated(res.apiKey);
      setConfirming(false);
    },
  });

  return (
    <div className="glass-card space-y-3 rounded-2xl p-4">
      <h2 className="font-display text-lg font-semibold">Rotate API key</h2>
      <p className="text-sm text-muted-foreground">
        Mints a new key and invalidates the old one immediately. narratorr (and any other client) must be updated with the
        new key. This browser is updated automatically.
      </p>
      {confirming ? (
        <div className="flex items-center gap-3">
          <span className="text-sm text-amber-500">This will break existing clients until they get the new key. Continue?</span>
          <Button variant="destructive" size="sm" loading={rotate.isPending} onClick={() => rotate.mutate()}>
            Confirm rotate
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button variant="secondary" icon={RefreshIcon} onClick={() => setConfirming(true)}>
          Rotate key
        </Button>
      )}
      {rotate.error && <p className="text-sm text-destructive">{String((rotate.error as Error).message)}</p>}
    </div>
  );
}
