import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

export type ToastVariant = "success" | "error" | "info" | "warning";

export type ToastItem = {
  id: string;
  message: string;
  variant: ToastVariant;
  duration?: number;
};

type ToastContextValue = {
  toasts: ToastItem[];
  addToast: (message: string, variant?: ToastVariant, duration?: number) => void;
  removeToast: (id: string) => void;
  clearToasts: () => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION = 4000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counterRef = useRef(0);

  const removeToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const addToast = useCallback((message: string, variant: ToastVariant = "info", duration?: number) => {
    counterRef.current += 1;
    const id = `toast-${counterRef.current}-${Date.now()}`;
    const newToast: ToastItem = { id, message, variant, duration };
    setToasts((current) => [...current, newToast]);

    const timeout = duration ?? DEFAULT_DURATION;
    if (timeout > 0) {
      setTimeout(() => {
        removeToast(id);
      }, timeout);
    }
  }, [removeToast]);

  const clearToasts = useCallback(() => {
    setToasts([]);
  }, []);

  const value = useMemo(
    () => ({ toasts, addToast, removeToast, clearToasts }),
    [toasts, addToast, removeToast, clearToasts]
  );

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}

export function ToastContainer() {
  const { toasts, removeToast } = useToast();

  if (!toasts.length) return null;

  return (
    <div className="toast-container" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast-${toast.variant}`}
          role="alert"
        >
          <div className="toast-content">
            <span className="toast-icon" aria-hidden="true">
              {toast.variant === "success" && "✓"}
              {toast.variant === "error" && "✕"}
              {toast.variant === "warning" && "⚠"}
              {toast.variant === "info" && "ℹ"}
            </span>
            <span className="toast-message">{toast.message}</span>
          </div>
          <button
            type="button"
            className="toast-close"
            onClick={() => removeToast(toast.id)}
            aria-label="Dismiss notification"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
