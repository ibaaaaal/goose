import { useState, useEffect, useCallback, useRef } from 'react';
import { useConfig } from './ConfigContext';
import {
  listLocalModels,
  downloadHfModel,
  getLocalModelDownloadProgress,
  cancelLocalModelDownload,
  type LocalModelResponse,
} from '../api';
import { trackOnboardingSetupFailed } from '../utils/analytics';
import { Goose } from './icons';

interface LocalModelSetupProps {
  onSuccess: () => void;
  onCancel: () => void;
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
};

type SetupPhase = 'loading' | 'select' | 'downloading' | 'error';

interface DownloadProgress {
  progress_percent: number;
  bytes_downloaded: number;
  total_bytes: number;
  speed_bps: number | null;
  eta_seconds: number | null;
}

export default function LocalModelSetup({ onSuccess, onCancel }: LocalModelSetupProps) {
  const { upsert } = useConfig();

  const [phase, setPhase] = useState<SetupPhase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<LocalModelResponse[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);

  const progressPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const downloadingModelIdRef = useRef<string | null>(null);

  // Load models on mount
  useEffect(() => {
    loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (progressPollRef.current) {
        clearInterval(progressPollRef.current);
      }
    };
  }, []);

  const loadModels = useCallback(async () => {
    try {
      setPhase('loading');
      const response = await listLocalModels();
      if (response.data) {
        setModels(response.data);
        // Auto-select recommended model that's already downloaded, or first recommended
        const downloaded = response.data.find(
          (m) => m.status.state === 'Downloaded' && m.recommended
        );
        const recommended = response.data.find((m) => m.recommended);
        setSelectedModelId(downloaded?.id || recommended?.id || null);
        setPhase('select');
      } else {
        throw new Error('Failed to load models');
      }
    } catch (err) {
      console.error('Failed to load models:', err);
      setError('Failed to load available models');
      setPhase('error');
      trackOnboardingSetupFailed('local', 'load_models_error');
    }
  }, []);

  const selectedModel = models.find((m) => m.id === selectedModelId);

  const startDownload = useCallback(async () => {
    if (!selectedModel) return;

    setPhase('downloading');
    setDownloadProgress(null);
    downloadingModelIdRef.current = selectedModel.id;

    try {
      // Start the download
      const result = await downloadHfModel({
        body: {
          repo_id: selectedModel.repo_id,
          filename: selectedModel.filename,
        },
      });

      if (result.error) {
        throw new Error('Failed to start download');
      }

      // Start polling for progress
      progressPollRef.current = setInterval(async () => {
        if (!downloadingModelIdRef.current) return;

        try {
          const progressResult = await getLocalModelDownloadProgress({
            path: { model_id: downloadingModelIdRef.current },
          });

          if (progressResult.data) {
            const data = progressResult.data;
            // Calculate progress percent from bytes
            const progressPercent =
              data.total_bytes > 0 ? (data.bytes_downloaded / data.total_bytes) * 100 : 0;

            if (data.status === 'downloading') {
              setDownloadProgress({
                progress_percent: progressPercent,
                bytes_downloaded: data.bytes_downloaded ?? 0,
                total_bytes: data.total_bytes ?? 0,
                speed_bps: data.speed_bps ?? null,
                eta_seconds: data.eta_seconds ?? null,
              });
            } else if (data.status === 'completed') {
              // Download complete!
              if (progressPollRef.current) {
                clearInterval(progressPollRef.current);
                progressPollRef.current = null;
              }
              handleDownloadComplete();
            } else if (data.status === 'failed') {
              throw new Error('Download failed');
            }
          }
        } catch (err) {
          console.error('Error polling progress:', err);
        }
      }, 500);
    } catch (err) {
      console.error('Failed to start download:', err);
      setError('Failed to start download');
      setPhase('error');
      trackOnboardingSetupFailed('local', 'download_start_error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModel]);

  const handleDownloadComplete = useCallback(async () => {
    if (!downloadingModelIdRef.current) return;

    const modelId = downloadingModelIdRef.current;
    downloadingModelIdRef.current = null;

    // Save config and notify success
    await upsert('GOOSE_PROVIDER', 'local', false);
    await upsert('GOOSE_MODEL', modelId, false);

    onSuccess();
  }, [upsert, onSuccess]);

  const handleCancel = useCallback(async () => {
    if (progressPollRef.current) {
      clearInterval(progressPollRef.current);
      progressPollRef.current = null;
    }

    if (downloadingModelIdRef.current) {
      try {
        await cancelLocalModelDownload({
          path: { model_id: downloadingModelIdRef.current },
        });
      } catch (err) {
        console.error('Failed to cancel download:', err);
      }
      downloadingModelIdRef.current = null;
    }

    setPhase('select');
    setDownloadProgress(null);
  }, []);

  const handlePrimaryAction = useCallback(async () => {
    if (!selectedModel) return;

    if (selectedModel.status.state === 'Downloaded') {
      // Model already downloaded, just use it
      await upsert('GOOSE_PROVIDER', 'local', false);
      await upsert('GOOSE_MODEL', selectedModel.id, false);
      onSuccess();
    } else {
      // Start download
      startDownload();
    }
  }, [selectedModel, upsert, onSuccess, startDownload]);

  const recommendedModels = models.filter((m) => m.recommended);
  const downloadedModels = models.filter((m) => m.status.state === 'Downloaded' && !m.recommended);

  return (
    <div className="w-full max-w-md mx-auto px-4 sm:px-6 py-6 sm:py-8">
      {/* Header */}
      <div className="text-center mb-6 sm:mb-8">
        <div className="w-12 h-12 sm:w-14 sm:h-14 mx-auto mb-3 sm:mb-4 bg-background-muted rounded-full flex items-center justify-center">
          <Goose className="w-7 h-7 sm:w-8 sm:h-8 text-text-default" />
        </div>
        <h1 className="text-xl sm:text-2xl font-semibold text-text-default mb-2">
          Set up Local AI
        </h1>
        <p className="text-text-muted text-sm sm:text-base">
          Run AI models privately on your computer
        </p>
      </div>

      {/* Loading state */}
      {phase === 'loading' && (
        <div className="flex flex-col items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-text-muted mb-4"></div>
          <p className="text-text-muted text-sm">Loading available models...</p>
        </div>
      )}

      {/* Error state */}
      {phase === 'error' && (
        <div className="space-y-4">
          <div className="border border-red-500/30 rounded-xl p-5 bg-red-500/10">
            <p className="text-red-400 text-sm">{error || 'An error occurred'}</p>
          </div>
          <button
            onClick={loadModels}
            className="w-full px-6 py-3 bg-background-muted text-text-default rounded-lg hover:bg-background-muted/80 transition-colors"
          >
            Try Again
          </button>
          <button
            onClick={onCancel}
            className="w-full px-6 py-3 bg-transparent text-text-muted rounded-lg hover:bg-background-muted transition-colors"
          >
            Back
          </button>
        </div>
      )}

      {/* Selection state */}
      {phase === 'select' && (
        <div className="space-y-6">
          {/* Recommended models */}
          {recommendedModels.length > 0 && (
            <div>
              <p className="text-text-muted text-xs uppercase tracking-wide mb-3">
                Recommended for your device
              </p>
              <div className="space-y-2">
                {recommendedModels.map((model) => (
                  <div
                    key={model.id}
                    onClick={() => setSelectedModelId(model.id)}
                    className={`border rounded-xl p-4 cursor-pointer transition-all ${
                      selectedModelId === model.id
                        ? 'border-blue-500 bg-blue-500/10'
                        : 'border-border-subtle hover:border-border-default'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-text-default text-sm">
                            {model.display_name}
                          </p>
                          {model.status.state === 'Downloaded' && (
                            <span className="text-xs bg-green-600 text-white px-2 py-0.5 rounded-full">
                              Ready
                            </span>
                          )}
                        </div>
                        <p className="text-text-muted text-xs mt-1">
                          {model.size_bytes ? formatBytes(model.size_bytes) : 'Unknown size'}
                          {model.context_limit && ` • ${model.context_limit.toLocaleString()} ctx`}
                        </p>
                      </div>
                      <div
                        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                          selectedModelId === model.id
                            ? 'border-blue-500 bg-blue-500'
                            : 'border-border-default'
                        }`}
                      >
                        {selectedModelId === model.id && (
                          <svg
                            className="w-3 h-3 text-white"
                            fill="currentColor"
                            viewBox="0 0 20 20"
                          >
                            <path
                              fillRule="evenodd"
                              d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                              clipRule="evenodd"
                            />
                          </svg>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Other downloaded models */}
          {downloadedModels.length > 0 && (
            <div>
              <p className="text-text-muted text-xs uppercase tracking-wide mb-3">
                Other downloaded models
              </p>
              <div className="space-y-2">
                {downloadedModels.map((model) => (
                  <div
                    key={model.id}
                    onClick={() => setSelectedModelId(model.id)}
                    className={`border rounded-xl p-4 cursor-pointer transition-all ${
                      selectedModelId === model.id
                        ? 'border-blue-500 bg-blue-500/10'
                        : 'border-border-subtle hover:border-border-default'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <p className="font-medium text-text-default text-sm">
                          {model.display_name}
                        </p>
                        <p className="text-text-muted text-xs mt-1">
                          {model.size_bytes ? formatBytes(model.size_bytes) : 'Unknown size'}
                          {model.context_limit && ` • ${model.context_limit.toLocaleString()} ctx`}
                        </p>
                      </div>
                      <div
                        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                          selectedModelId === model.id
                            ? 'border-blue-500 bg-blue-500'
                            : 'border-border-default'
                        }`}
                      >
                        {selectedModelId === model.id && (
                          <svg
                            className="w-3 h-3 text-white"
                            fill="currentColor"
                            viewBox="0 0 20 20"
                          >
                            <path
                              fillRule="evenodd"
                              d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                              clipRule="evenodd"
                            />
                          </svg>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Primary action */}
          <button
            onClick={handlePrimaryAction}
            disabled={!selectedModelId}
            className="w-full px-6 py-3 bg-background-muted text-text-default rounded-lg transition-colors font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-background-muted/80"
          >
            {selectedModel?.status.state === 'Downloaded'
              ? `Use ${selectedModel.display_name}`
              : selectedModel
                ? `Download ${selectedModel.display_name} (${selectedModel.size_bytes ? formatBytes(selectedModel.size_bytes) : ''})`
                : 'Select a model'}
          </button>

          <button
            onClick={onCancel}
            className="w-full px-6 py-3 bg-transparent text-text-muted rounded-lg hover:bg-background-muted transition-colors"
          >
            Back
          </button>
        </div>
      )}

      {/* Downloading state */}
      {phase === 'downloading' && selectedModel && (
        <div className="space-y-6">
          <div className="border border-border-subtle rounded-xl p-5 sm:p-6 bg-background-default">
            <p className="font-medium text-text-default text-sm sm:text-base mb-4">
              Downloading {selectedModel.display_name}
            </p>

            {downloadProgress ? (
              <div className="space-y-3">
                {/* Progress bar */}
                <div className="w-full bg-background-subtle rounded-full h-2 overflow-hidden">
                  <div
                    className="bg-blue-500 h-2 rounded-full transition-all duration-500 ease-out"
                    style={{ width: `${downloadProgress.progress_percent}%` }}
                  />
                </div>

                {/* Stats row */}
                <div className="flex justify-between text-xs text-text-muted">
                  <span>
                    {formatBytes(downloadProgress.bytes_downloaded)} of{' '}
                    {formatBytes(downloadProgress.total_bytes)}
                  </span>
                  <span>{downloadProgress.progress_percent.toFixed(0)}%</span>
                </div>

                <div className="flex justify-between text-xs text-text-muted">
                  {downloadProgress.speed_bps ? (
                    <span>{formatBytes(downloadProgress.speed_bps)}/s</span>
                  ) : (
                    <span />
                  )}
                  {downloadProgress.eta_seconds != null && downloadProgress.eta_seconds > 0 && (
                    <span>
                      ~
                      {downloadProgress.eta_seconds < 60
                        ? `${Math.round(downloadProgress.eta_seconds)}s`
                        : `${Math.round(downloadProgress.eta_seconds / 60)}m`}{' '}
                      remaining
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-text-muted"></div>
                <span className="text-sm text-text-muted">Starting download...</span>
              </div>
            )}
          </div>

          <button
            onClick={handleCancel}
            className="w-full px-6 py-3 bg-transparent text-text-muted rounded-lg hover:bg-background-muted transition-colors border border-border-subtle"
          >
            Cancel Download
          </button>
        </div>
      )}
    </div>
  );
}
