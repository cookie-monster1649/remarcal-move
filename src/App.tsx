import React, { useEffect, useRef, useState } from 'react';
import { Calendar, Settings, Plus, Trash2, RefreshCw, CheckCircle, XCircle, Clock, Tablet, Wifi, WifiOff, Download, LogOut, Shield, Moon, Sun, Monitor } from 'lucide-react';
import axios from 'axios';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Card, CardContent } from './components/ui/card';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { Progress } from './components/ui/progress';
import { cn, safeParseJsonArray } from './lib/utils';

axios.defaults.withCredentials = true;

// Types
interface Document {
  id: string;
  title: string;
  type: string;
  remote_path: string;
  last_synced_at: string;
  sync_status: 'idle' | 'checking' | 'queued' | 'pending_connection' | 'syncing' | 'error';
  sync_phase?: 'idle' | 'queued' | 'preparing' | 'generating_pdf' | 'uploading' | 'finalizing' | 'done' | 'cancelled' | 'error';
  sync_progress?: number;
  last_error: string;
  year: number;
  timezone: string;
  caldav_account_id: string;
  caldav_account_ids: string[];
  subscription_ids: string[];
  device_id: string;
}

interface Account {
  id: string;
  name: string;
  url: string;
  username: string;
  selected_calendars: string; // JSON string
}

interface Subscription {
  id: string;
  name: string;
  owner_email?: string | null;
  update_frequency_minutes: number;
  enabled: number;
  last_fetched_at?: string;
  last_success_at?: string;
  last_error?: string;
}

interface Device {
  id: string;
  name: string;
  host: string;
  username: string;
  port: number;
  sync_when_connected: number;
  backup_enabled: number;
  backup_frequency_hours: number;
  last_backup_at?: string | null;
  last_connected_at: string;
  auth_mode?: 'password' | 'key';
  allow_password_fallback?: number;
}

interface DeviceBackup {
  id: string;
  device_id: string;
  device_name?: string;
  status: 'running' | 'success' | 'error' | 'partial' | 'cancelled';
  started_at: string;
  completed_at?: string | null;
  doc_count?: number;
  byte_count?: number;
  error?: string | null;
}

interface BackupProgress {
  backupId: string;
  deviceId: string;
  phase: 'preflight' | 'transfer' | 'manifest' | 'finalize' | 'done' | 'cancelled' | 'error';
  transferredBytes: number;
  totalBytes: number;
  totalFiles: number;
  speedBytesPerSec?: number;
  percent?: number;
  updatedAt: string;
  message?: string;
}

interface BackupDiagnosticsDevice {
  device_id: string;
  device_name: string;
  auth_mode: 'password' | 'key';
  allow_password_fallback: boolean;
  has_fs_private_key: boolean;
  has_db_private_key: boolean;
  has_password: boolean;
  effective_auth: 'key' | 'password' | 'invalid';
  rsync_binary_available: boolean;
  will_use_rsync: boolean;
  expected_transfer_method: 'rsync' | 'sftp';
  reason: string;
}

interface BackupDiagnosticsResponse {
  generated_at: string;
  rsync_binary_available: boolean;
  devices: BackupDiagnosticsDevice[];
}

interface InfoLogEvent {
  ts: string;
  level: 'info' | 'warn' | 'error';
  event: string;
  [key: string]: any;
}

interface UiToast {
  id: number;
  kind: 'success' | 'error' | 'info';
  message: string;
}

type ThemeMode = 'system' | 'light' | 'dark';

const THEME_STORAGE_KEY = 'remarcal_move.theme_mode';

const getInitialThemeMode = (): ThemeMode => {
  if (typeof window === 'undefined') return 'system';
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
};

const getNextThemeMode = (current: ThemeMode): ThemeMode => {
  if (current === 'light') return 'dark';
  if (current === 'dark') return 'system';
  return 'light';
};

export default function App() {
  const DATA_POLL_MS = 120000;
  const DEVICE_CHECK_MS = 120000;
  const ACTIVE_PROGRESS_POLL_MS = 5000;
  const IDLE_PROGRESS_POLL_MS = 120000;
  const DIAGNOSTICS_POLL_MS = 120000;

  const [activeTab, setActiveTab] = useState<'library' | 'settings' | 'devices'>('library');
  const [documents, setDocuments] = useState<Document[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [backups, setBackups] = useState<DeviceBackup[]>([]);
  const [backupProgress, setBackupProgress] = useState<Record<string, BackupProgress>>({});
  const [backupDiagnosticsByDevice, setBackupDiagnosticsByDevice] = useState<Record<string, BackupDiagnosticsDevice>>({});
  const [backupDiagnosticsRsyncAvailable, setBackupDiagnosticsRsyncAvailable] = useState<boolean | null>(null);
  const [backupDiagnosticsAt, setBackupDiagnosticsAt] = useState<string | null>(null);
  const [backupDiagnosticsLoading, setBackupDiagnosticsLoading] = useState(false);
  const [backupDiagnosticsError, setBackupDiagnosticsError] = useState<string | null>(null);
  const [infoLogs, setInfoLogs] = useState<InfoLogEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [discoveredCalendars, setDiscoveredCalendars] = useState<{url: string, name: string}[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [deviceStatus, setDeviceStatus] = useState<Record<string, 'connected' | 'disconnected' | 'checking'>>({});
  const [authenticated, setAuthenticated] = useState<boolean>(false);
  const [authChecked, setAuthChecked] = useState<boolean>(false);
  const [authPassword, setAuthPassword] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<UiToast[]>([]);
  const toastIdRef = useRef(0);
  const [confirmState, setConfirmState] = useState<{ open: boolean; title: string; description: string; onConfirm: (() => Promise<void>) | null }>({
    open: false,
    title: '',
    description: '',
    onConfirm: null,
  });
  const [confirmSubmitting, setConfirmSubmitting] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(getInitialThemeMode);
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  // Forms state
  const [showDocForm, setShowDocForm] = useState(false);
  const [editingDoc, setEditingDoc] = useState<Document | null>(null);
  const [docForm, setDocForm] = useState({
    title: '',
    remote_path: '/home/root/.local/share/remarkable/xochitl/calendar.pdf',
    year: new Date().getFullYear(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    caldav_account_ids: [] as string[],
    subscription_ids: [] as string[],
    device_id: ''
  });

  const [showAccountForm, setShowAccountForm] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [accountForm, setAccountForm] = useState({
    name: '',
    url: '',
    username: '',
    password: '',
    selected_calendars: [] as {url: string, name: string}[]
  });

  const [showSubscriptionForm, setShowSubscriptionForm] = useState(false);
  const [editingSubscription, setEditingSubscription] = useState<Subscription | null>(null);
  const [subscriptionForm, setSubscriptionForm] = useState({
    name: '',
    url: '',
    owner_email: '',
    update_frequency_minutes: 30,
    enabled: true,
  });
  const [accountTestStatus, setAccountTestStatus] = useState<Record<string, { state: 'idle' | 'running' | 'success' | 'error'; message?: string; count?: number; at?: string }>>({});
  const [subscriptionFetchStatus, setSubscriptionFetchStatus] = useState<Record<string, { state: 'idle' | 'running' | 'success' | 'error'; message?: string; count?: number; at?: string }>>({});
  const [manualSyncStatus, setManualSyncStatus] = useState<Record<string, boolean>>({});
  const [manualBackupStatus, setManualBackupStatus] = useState<Record<string, boolean>>({});
  const [cancellingBackupStatus, setCancellingBackupStatus] = useState<Record<string, boolean>>({});
  const [enrollKeyStatus, setEnrollKeyStatus] = useState<Record<string, boolean>>({});

  const [showDeviceForm, setShowDeviceForm] = useState(false);
  const [editingDevice, setEditingDevice] = useState<Device | null>(null);
  const [deviceForm, setDeviceForm] = useState({
    name: '',
    host: '',
    username: 'root',
    password: '',
    port: 22,
    sync_when_connected: false,
    backup_enabled: false,
    backup_frequency_hours: 24,
    allow_password_fallback: true,
  });
  const isAnyFormModalOpen = showDocForm || showDeviceForm || showAccountForm || showSubscriptionForm;
  const docModalRef = useRef<HTMLDivElement | null>(null);
  const deviceModalRef = useRef<HTMLDivElement | null>(null);
  const accountModalRef = useRef<HTMLDivElement | null>(null);
  const subscriptionModalRef = useRef<HTMLDivElement | null>(null);

  const pushToast = (kind: UiToast['kind'], message: string) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, kind, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  const openConfirm = (title: string, description: string, onConfirm: () => Promise<void>) => {
    setConfirmState({ open: true, title, description, onConfirm });
  };

  const closeConfirm = () => {
    if (confirmSubmitting) return;
    setConfirmState({ open: false, title: '', description: '', onConfirm: null });
  };

  const resolvedTheme: 'light' | 'dark' = themeMode === 'system' ? (systemPrefersDark ? 'dark' : 'light') : themeMode;

  useEffect(() => {
    if (!isAnyFormModalOpen && !confirmState.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (confirmState.open) {
        closeConfirm();
        return;
      }
      if (showDocForm) setShowDocForm(false);
      if (showDeviceForm) setShowDeviceForm(false);
      if (showAccountForm) setShowAccountForm(false);
      if (showSubscriptionForm) setShowSubscriptionForm(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isAnyFormModalOpen, confirmState.open, confirmSubmitting, showDocForm, showDeviceForm, showAccountForm, showSubscriptionForm]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => {
      setSystemPrefersDark(event.matches);
    };

    setSystemPrefersDark(mediaQuery.matches);
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', onChange);
      return () => mediaQuery.removeEventListener('change', onChange);
    }
    mediaQuery.addListener(onChange);
    return () => mediaQuery.removeListener(onChange);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    const root = document.documentElement;
    root.classList.remove('theme-light', 'theme-dark');
    root.classList.add(resolvedTheme === 'dark' ? 'theme-dark' : 'theme-light');
  }, [themeMode, resolvedTheme]);

  useEffect(() => {
    if (!isAnyFormModalOpen) return;
    const root = showDocForm
      ? docModalRef.current
      : showDeviceForm
        ? deviceModalRef.current
        : showAccountForm
          ? accountModalRef.current
          : subscriptionModalRef.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>('input, select, textarea, button');
    target?.focus();
  }, [isAnyFormModalOpen, showDocForm, showDeviceForm, showAccountForm, showSubscriptionForm]);

  const trapFocusWithin = (event: React.KeyboardEvent, root: HTMLDivElement | null) => {
    if (event.key !== 'Tab' || !root) return;
    const focusable = root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const fetchData = async () => {
    if (!authenticated) return;
    setLoading(true);
    try {
      const [docsRes, accountsRes, subsRes, devicesRes, backupsRes] = await Promise.all([
        axios.get('/api/library'),
        axios.get('/api/settings'),
        axios.get('/api/settings/subscriptions'),
        axios.get('/api/devices'),
        axios.get('/api/backups?limit=200'),
      ]);
      
      // Defensive check: ensure data is an array
      const docsData = Array.isArray(docsRes.data) ? docsRes.data : (docsRes.data.documents || []);
      const accountsData = Array.isArray(accountsRes.data) ? accountsRes.data : [];
      const subscriptionsData = Array.isArray(subsRes.data) ? subsRes.data : [];
      const devicesData = Array.isArray(devicesRes.data) ? devicesRes.data : [];
      const backupsData = Array.isArray(backupsRes.data) ? backupsRes.data : [];
      
      setDocuments(docsData);
      setAccounts(accountsData);
      setSubscriptions(subscriptionsData);
      setDevices(devicesData);
      setBackups(backupsData);
      setCancellingBackupStatus((prev) => {
        const runningIds = new Set(
          backupsData
            .filter((b: DeviceBackup) => b.status === 'running')
            .map((b: DeviceBackup) => b.id),
        );
        const next: Record<string, boolean> = {};
        for (const id of Object.keys(prev)) {
          if (runningIds.has(id)) next[id] = true;
        }
        return next;
      });
      setError(null);
    } catch (err: any) {
      setError(err.response?.data?.error || err.message);
      if (err.response?.status === 401) {
          setAuthenticated(false);
      }
    } finally {
      setLoading(false);
    }
  };

  const checkAuth = async () => {
    try {
      await axios.get('/api/auth/me');
      setAuthenticated(true);
      setAuthError(null);
    } catch {
      setAuthenticated(false);
    } finally {
      setAuthChecked(true);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthSubmitting(true);
    setAuthError(null);
    try {
      await axios.post('/api/auth/login', { password: authPassword });
      setAuthenticated(true);
      setAuthPassword('');
      await fetchData();
    } catch (err: any) {
      setAuthError(err.response?.data?.error || 'Authentication failed');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleLogout = async () => {
    try {
      await axios.post('/api/auth/logout');
    } catch {
      // ignore
    }
    setAuthenticated(false);
  };

  const checkConnectionForDevice = async (deviceId: string) => {
    setDeviceStatus((prev) => ({ ...prev, [deviceId]: 'checking' }));
    try {
      await axios.post(`/api/devices/${deviceId}/check`);
      setDeviceStatus((prev) => ({ ...prev, [deviceId]: 'connected' }));
    } catch {
      setDeviceStatus((prev) => ({ ...prev, [deviceId]: 'disconnected' }));
    }
  };

  // Check connection for all devices
  const checkConnections = async () => {
    if (devices.length === 0) return;
    await Promise.all(devices.map((dev) => checkConnectionForDevice(dev.id)));
  };

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    fetchData();
    const interval = setInterval(fetchData, DATA_POLL_MS);
    return () => clearInterval(interval);
  }, [authenticated, DATA_POLL_MS]);

  useEffect(() => {
    if (!authenticated) return;
    if (devices.length > 0) {
        checkConnections();
        const interval = setInterval(checkConnections, DEVICE_CHECK_MS);
        return () => clearInterval(interval);
    }
  }, [authenticated, devices.length, DEVICE_CHECK_MS]); // Re-run when devices list changes

  const handleDocSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setModalError(null);
    try {
      if (editingDoc) {
        await axios.put(`/api/library/${editingDoc.id}`, docForm);
      } else {
        await axios.post('/api/library', docForm);
      }
      setShowDocForm(false);
      setEditingDoc(null);
      fetchData();
    } catch (err: any) {
      setModalError(err.response?.data?.error || err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleAccountSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setModalError(null);
    try {
      if (editingAccount) {
        await axios.put(`/api/settings/${editingAccount.id}`, accountForm);
      } else {
        await axios.post('/api/settings', accountForm);
      }
      setShowAccountForm(false);
      setEditingAccount(null);
      setAccountForm({ name: '', url: '', username: '', password: '', selected_calendars: [] });
      setDiscoveredCalendars([]);
      fetchData();
    } catch (err: any) {
      setModalError(err.response?.data?.error || err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDiscover = async () => {
    if (!accountForm.url) {
      setModalError('Please enter a CalDAV URL first');
      return;
    }
    setDiscovering(true);
    setModalError(null);
    try {
      const res = await axios.post('/api/settings/discover', {
        url: accountForm.url,
        username: accountForm.username,
        password: accountForm.password,
        accountId: editingAccount?.id
      });
      setDiscoveredCalendars(res.data);
      if (res.data.length === 0) {
        setModalError('No calendars found at this URL');
      }
    } catch (err: any) {
      setModalError(err.response?.data?.error || err.message);
    } finally {
      setDiscovering(false);
    }
  };

  const handleDeviceSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setModalError(null);
    try {
      if (editingDevice) {
        await axios.put(`/api/devices/${editingDevice.id}`, deviceForm);
      } else {
        await axios.post('/api/devices', deviceForm);
      }
      setShowDeviceForm(false);
      setEditingDevice(null);
      setDeviceForm({
        name: '',
        host: '',
        username: 'root',
        password: '',
        port: 22,
        sync_when_connected: false,
        backup_enabled: false,
        backup_frequency_hours: 24,
        allow_password_fallback: true,
      });
      fetchData();
    } catch (err: any) {
      setModalError(err.response?.data?.error || err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubscriptionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setModalError(null);
    try {
      if (editingSubscription) {
        await axios.put(`/api/settings/subscriptions/${editingSubscription.id}`, subscriptionForm);
      } else {
        await axios.post('/api/settings/subscriptions', subscriptionForm);
      }
      setShowSubscriptionForm(false);
      setEditingSubscription(null);
      setSubscriptionForm({ name: '', url: '', owner_email: '', update_frequency_minutes: 30, enabled: true });
      fetchData();
    } catch (err: any) {
      setModalError(err.response?.data?.error || err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const deleteDoc = async (id: string) => {
    openConfirm('Delete document?', 'This action cannot be undone.', async () => {
      await axios.delete(`/api/library/${id}`);
      await fetchData();
      pushToast('success', 'Document deleted');
    });
  };

  const deleteAccount = async (id: string) => {
    openConfirm('Delete CalDAV account?', 'This removes the account from all document sync jobs.', async () => {
      await axios.delete(`/api/settings/${id}`);
      await fetchData();
      pushToast('success', 'Account deleted');
    });
  };

  const deleteDevice = async (id: string) => {
    openConfirm('Delete device?', 'Any documents assigned to this device will need a new target device.', async () => {
      await axios.delete(`/api/devices/${id}`);
      await fetchData();
      pushToast('success', 'Device deleted');
    });
  };

  const deleteSubscription = async (id: string) => {
    openConfirm('Delete subscription?', 'Future fetches for this feed will stop.', async () => {
      await axios.delete(`/api/settings/subscriptions/${id}`);
      await fetchData();
      pushToast('success', 'Subscription deleted');
    });
  };

  const testAccount = async (id: string) => {
    setAccountTestStatus(prev => ({ ...prev, [id]: { state: 'running' } }));
    try {
      const res = await axios.post(`/api/settings/${id}/test`);
      setAccountTestStatus(prev => ({
        ...prev,
        [id]: {
          state: 'success',
          message: res.data?.message || 'Connection OK',
          count: res.data?.eventsFetched,
          at: new Date().toISOString(),
        },
      }));
    } catch (err: any) {
      setAccountTestStatus(prev => ({
        ...prev,
        [id]: {
          state: 'error',
          message: err.response?.data?.error || err.message,
          at: new Date().toISOString(),
        },
      }));
    }
  };

  const fetchSubscriptionNow = async (id: string) => {
    setSubscriptionFetchStatus(prev => ({ ...prev, [id]: { state: 'running' } }));
    try {
      const res = await axios.post(`/api/settings/subscriptions/${id}/fetch`);
      setSubscriptionFetchStatus(prev => ({
        ...prev,
        [id]: {
          state: 'success',
          message: res.data?.message || 'Fetched',
          count: res.data?.eventsStored,
          at: new Date().toISOString(),
        },
      }));
      fetchData();
    } catch (err: any) {
      setSubscriptionFetchStatus(prev => ({
        ...prev,
        [id]: {
          state: 'error',
          message: err.response?.data?.error || err.message,
          at: new Date().toISOString(),
        },
      }));
    }
  };

  const syncDoc = async (id: string) => {
    setManualSyncStatus(prev => ({ ...prev, [id]: true }));
    try {
      await axios.post(`/api/library/${id}/sync`);
      fetchData();
    } catch (err: any) {
      pushToast('error', err.response?.data?.error || err.message || 'Failed to sync');
    } finally {
      setManualSyncStatus(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  const cancelDocSync = async (id: string) => {
    try {
      await axios.post(`/api/library/${id}/sync/cancel`);
      await fetchData();
    } catch (err: any) {
      pushToast('error', err.response?.data?.error || err.message || 'Failed to cancel sync');
    } finally {
      setManualSyncStatus(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  const runDeviceBackup = async (deviceId: string) => {
    setManualBackupStatus(prev => ({ ...prev, [deviceId]: true }));
    try {
      await axios.post(`/api/backups/device/${deviceId}`);
      await fetchData();
    } catch (err: any) {
      pushToast('error', err.response?.data?.error || err.message || 'Failed to start backup');
    } finally {
      setManualBackupStatus(prev => {
        const next = { ...prev };
        delete next[deviceId];
        return next;
      });
    }
  };

  const cancelDeviceBackup = async (backupId: string) => {
    setCancellingBackupStatus(prev => ({ ...prev, [backupId]: true }));
    try {
      await axios.post(`/api/backups/${backupId}/cancel`);
      await fetchData();
    } catch (err: any) {
      setCancellingBackupStatus(prev => {
        const next = { ...prev };
        delete next[backupId];
        return next;
      });
      pushToast('error', err.response?.data?.error || err.message || 'Failed to cancel backup');
    }
  };

  const enrollDeviceKey = async (deviceId: string) => {
    setEnrollKeyStatus(prev => ({ ...prev, [deviceId]: true }));
    try {
      await axios.post(`/api/devices/${deviceId}/enroll-key`);
      await fetchData();
    } catch (err: any) {
      pushToast('error', err.response?.data?.error || err.message || 'Failed to enroll SSH key');
    } finally {
      setEnrollKeyStatus(prev => {
        const next = { ...prev };
        delete next[deviceId];
        return next;
      });
    }
  };

  const formatDateTime = (value?: string | null) => {
    if (!value) return 'Never';
    try {
      return new Date(value).toLocaleString();
    } catch {
      return 'Never';
    }
  };

  const loadBackupDiagnostics = async () => {
    setBackupDiagnosticsLoading(true);
    try {
      const res = await axios.get('/api/backups/diagnostics');
      const payload = (res.data || {}) as BackupDiagnosticsResponse;
      const rows = Array.isArray(payload.devices) ? payload.devices : [];
      const next: Record<string, BackupDiagnosticsDevice> = {};
      for (const row of rows) {
        if (!row?.device_id) continue;
        next[row.device_id] = row;
      }
      setBackupDiagnosticsByDevice(next);
      setBackupDiagnosticsRsyncAvailable(
        typeof payload.rsync_binary_available === 'boolean' ? payload.rsync_binary_available : null,
      );
      setBackupDiagnosticsAt(payload.generated_at || new Date().toISOString());
      setBackupDiagnosticsError(null);
    } catch (err: any) {
      setBackupDiagnosticsError(err.response?.data?.error || err.message || 'Failed to load diagnostics');
    } finally {
      setBackupDiagnosticsLoading(false);
    }
  };

  const getLatestBackupForDevice = (deviceId: string) => {
    return backups
      .filter((b) => b.device_id === deviceId)
      .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())[0];
  };

  useEffect(() => {
    if (!authenticated) return;
    if (activeTab !== 'devices') return;

    const poll = async () => {
      try {
        const running = backups.filter((b) => b.status === 'running');
        const progressEntries = await Promise.all(
          running.map(async (b) => {
            try {
              const res = await axios.get(`/api/backups/${b.id}/progress`);
              return [b.id, res.data] as const;
            } catch {
              return [b.id, null] as const;
            }
          }),
        );

        const next: Record<string, BackupProgress> = {};
        for (const [id, progress] of progressEntries) {
          if (progress) next[id] = progress;
        }
        setBackupProgress(next);

        const logsRes = await axios.get('/api/backups/logs/recent?limit=120');
        setInfoLogs(Array.isArray(logsRes.data) ? logsRes.data : []);
      } catch {
        // ignore polling errors in UI refresh loop
      }
    };

    const hasRunningBackups = backups.some((b) => b.status === 'running');
    const intervalMs = hasRunningBackups ? ACTIVE_PROGRESS_POLL_MS : IDLE_PROGRESS_POLL_MS;
    void poll();
    const interval = setInterval(() => {
      void poll();
    }, intervalMs);
    return () => clearInterval(interval);
  }, [authenticated, activeTab, backups, ACTIVE_PROGRESS_POLL_MS, IDLE_PROGRESS_POLL_MS]);

  useEffect(() => {
    if (!authenticated) return;
    if (activeTab !== 'devices') return;

    void loadBackupDiagnostics();
    const interval = setInterval(() => {
      void loadBackupDiagnostics();
    }, DIAGNOSTICS_POLL_MS);
    return () => clearInterval(interval);
  }, [authenticated, activeTab, devices.length, DIAGNOSTICS_POLL_MS]);

  const downloadDocPdf = async (doc: Document) => {
    try {
      const response = await axios.get(`/api/library/${doc.id}/download`, {
        responseType: 'blob',
      });
      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      const safeTitle = (doc.title || `document-${doc.id}`)
        .toString()
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '') || `document-${doc.id}`;
      link.href = url;
      link.download = `${safeTitle}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      pushToast('error', err.response?.data?.error || err.message || 'Failed to download PDF');
    }
  };

  return (
    <div className="remarkable-ui min-h-screen text-stone-900 font-sans transition-colors duration-300">
      {!authChecked ? (
        <div className="min-h-screen flex items-center justify-center text-stone-600">Checking session…</div>
      ) : !authenticated ? (
        <div className="min-h-screen flex items-center justify-center p-4">
          <form onSubmit={handleLogin} className="bg-white border border-stone-200 rounded-2xl shadow-sm p-8 w-full max-w-sm space-y-4">
            <div className="flex items-center gap-2">
              <Shield size={18} />
              <h1 className="text-lg font-semibold">remarcal-move Login</h1>
            </div>
            {authError && <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded p-2">{authError}</div>}
            <div>
              <Label className="mb-1 block">Admin password</Label>
              <Input
                type="password"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                required
              />
            </div>
            <Button type="submit" disabled={authSubmitting} className="w-full">
              {authSubmitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </div>
      ) : (
      <>
      <header className="remarkable-header sticky top-0 z-20 border-b border-stone-200/80 bg-white/90 p-4 backdrop-blur">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <div className="rm-brand-mark w-8 h-8 bg-stone-900 text-white flex items-center justify-center rounded-lg">
                <Calendar size={20} />
              </div>
              <div className="min-w-0">
                <h1 className="rm-brand-title text-2xl leading-none tracking-tight">remarcal-move</h1>
                <p className="text-xs text-stone-500 mt-1">Calendar sync orchestration for reMarkable devices</p>
              </div>
              {devices.length > 0 && (
                <div className="hidden lg:flex flex-wrap items-center gap-2 pl-2">
                  {devices.map((dev) => {
                    const status = deviceStatus[dev.id] || 'disconnected';
                    const isChecking = status === 'checking';
                    const isConnected = status === 'connected';
                    return (
                      <button
                        key={dev.id}
                        type="button"
                        onClick={() => checkConnectionForDevice(dev.id)}
                        disabled={isChecking}
                        className={cn(
                          'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors disabled:opacity-70',
                          status === 'connected'
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                            : status === 'checking'
                              ? 'border-stone-300 bg-stone-100 text-stone-600'
                              : 'border-red-200 bg-red-50 text-red-700',
                        )}
                        title={`Click to test connection: ${dev.name}`}
                      >
                        {isChecking ? (
                          <RefreshCw size={12} className="animate-spin" />
                        ) : isConnected ? (
                          <Wifi size={12} />
                        ) : (
                          <WifiOff size={12} />
                        )}
                        <span>{dev.name}</span>
                        <span className="opacity-85">{isChecking ? 'Checking' : isConnected ? 'Connected' : 'Offline'}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <nav className="inline-flex items-center rounded-xl border border-stone-200 bg-stone-100/70 p-1">
                <Button
                  onClick={() => setActiveTab('library')}
                  variant={activeTab === 'library' ? 'default' : 'ghost'}
                  size="sm"
                  className="rounded-lg px-4"
                >
                  Library
                </Button>
                <Button
                  onClick={() => setActiveTab('devices')}
                  variant={activeTab === 'devices' ? 'default' : 'ghost'}
                  size="sm"
                  className="rounded-lg px-4"
                >
                  Devices
                </Button>
                <Button
                  onClick={() => setActiveTab('settings')}
                  variant={activeTab === 'settings' ? 'default' : 'ghost'}
                  size="sm"
                  className="rounded-lg px-4"
                >
                  Calendars
                </Button>
              </nav>
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => setThemeMode(getNextThemeMode(themeMode))}
                  variant="secondary"
                  size="icon"
                  className="h-9 w-9 rounded-full"
                  title={`Theme: ${themeMode} (${resolvedTheme}). Click to cycle`}
                  aria-label="Toggle theme mode"
                >
                  {themeMode === 'system' ? <Monitor size={15} /> : resolvedTheme === 'dark' ? <Moon size={15} /> : <Sun size={15} />}
                </Button>
                <Button onClick={handleLogout} variant="ghost" size="sm" className="gap-1">
                  <LogOut size={14} />
                  Logout
                </Button>
              </div>
            </div>
          </div>
          {devices.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2 lg:hidden">
              {devices.map((dev) => {
                const status = deviceStatus[dev.id] || 'disconnected';
                const isChecking = status === 'checking';
                const isConnected = status === 'connected';
                return (
                  <button
                    key={dev.id}
                    type="button"
                    onClick={() => checkConnectionForDevice(dev.id)}
                    disabled={isChecking}
                    className={cn(
                      'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors disabled:opacity-70',
                      status === 'connected'
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                        : status === 'checking'
                          ? 'border-stone-300 bg-stone-100 text-stone-600'
                          : 'border-red-200 bg-red-50 text-red-700',
                    )}
                    title={`Click to test connection: ${dev.name}`}
                  >
                    {isChecking ? (
                      <RefreshCw size={12} className="animate-spin" />
                    ) : isConnected ? (
                      <Wifi size={12} />
                    ) : (
                      <WifiOff size={12} />
                    )}
                    <span>{dev.name}</span>
                    <span className="opacity-85">{isChecking ? 'Checking' : isConnected ? 'Connected' : 'Offline'}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4 md:p-6">
        {loading && (
          <div className="mb-4 text-xs text-stone-500 flex items-center gap-2">
            <RefreshCw size={12} className="animate-spin" />
            Refreshing data
          </div>
        )}
        {error && (
            <div className="mb-6 p-4 bg-red-50 text-red-700 rounded-lg flex items-center gap-2">
                <XCircle size={18} />
                {error}
            </div>
        )}

        {activeTab === 'library' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-2xl font-bold">Documents</h2>
              <Button
                onClick={() => {
                    setEditingDoc(null);
                    setDocForm({
                        title: '',
                        remote_path: '/home/root/.local/share/remarkable/xochitl/calendar.pdf',
                        year: new Date().getFullYear(),
                        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
                        caldav_account_ids: accounts.length > 0 ? [accounts[0].id] : [],
                        subscription_ids: subscriptions.length > 0 ? [subscriptions[0].id] : [],
                        device_id: devices.length > 0 ? devices[0].id : ''
                    });
                    setShowDocForm(true);
                }}
                className="gap-2"
              >
                <Plus size={18} />
                Add Document
              </Button>
            </div>

            {documents.length === 0 ? (
                <Card className="text-center py-12 text-stone-500">
                    No documents found. Create one to get started.
                </Card>
            ) : (
                <div className="grid gap-4">
                    {documents.map(doc => {
                        const isSyncing = doc.sync_status === 'syncing' || !!manualSyncStatus[doc.id];
                        const isQueued = doc.sync_status === 'queued';
                        const isPendingConnection = doc.sync_status === 'pending_connection';
                        const rawProgress = typeof doc.sync_progress === 'number' ? doc.sync_progress : (isSyncing ? 10 : 0);
                        const progress = Math.max(0, Math.min(100, Math.round(rawProgress)));
                        return (
                        <Card key={doc.id} className="p-6 flex flex-col md:flex-row justify-between gap-4">
                            <div className="flex-1">
                                <div className="flex items-center gap-2 mb-1">
                                    <h3 className="font-bold text-lg">{doc.title}</h3>
                                    {isSyncing && <RefreshCw size={14} className="animate-spin text-blue-500" />}
                                    {isQueued && <Clock size={14} className="text-amber-600" />}
                                    {isPendingConnection && <Clock size={14} className="text-amber-700" />}
                                    {doc.sync_status === 'error' && <XCircle size={14} className="text-red-500" />}
                                    {!isSyncing && doc.sync_status === 'idle' && doc.last_synced_at && <CheckCircle size={14} className="text-green-500" />}
                                </div>
                                <p className="text-sm text-stone-500 font-mono mb-2">{doc.remote_path}</p>
                                <div className="flex items-center gap-4 text-xs text-stone-500">
                                    <span className="flex items-center gap-1">
                                        <Clock size={12} />
                                        {doc.device_id ? 'Sync when connected (device setting)' : 'Manual Sync Only'}
                                    </span>
                                    {doc.last_synced_at && (
                                        <span>Last synced: {new Date(doc.last_synced_at).toLocaleString()}</span>
                                    )}
                                    {isQueued && <Badge variant="warning">Queued (waiting for backup/device lock)</Badge>}
                                    {isPendingConnection && <Badge variant="warning">Pending connection</Badge>}
                                </div>
                                {(isSyncing || isQueued) && (
                                  <div className="mt-3">
                                    <div className="flex justify-between text-[11px] text-stone-600 mb-1">
                                      <span>{getSyncPhaseLabel(doc.sync_phase)}</span>
                                      <span>{progress}%</span>
                                    </div>
                                    <Progress value={progress} />
                                  </div>
                                )}
                                {doc.last_error && (
                                    <p className="text-xs text-red-600 mt-2 bg-red-50 p-2 rounded">Error: {doc.last_error}</p>
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                                <Button
                                    onClick={() => downloadDocPdf(doc)}
                                    variant="ghost"
                                    size="icon"
                                    title="Download PDF"
                                >
                                    <Download size={20} />
                                </Button>
                                <Button
                                    onClick={() => syncDoc(doc.id)}
                                    disabled={isSyncing}
                                    variant="ghost"
                                    size="icon"
                                    title="Sync Now"
                                >
                                    <RefreshCw size={20} className={isSyncing ? 'animate-spin' : ''} />
                                </Button>
                                {(isSyncing || isQueued) && (
                                  <Button
                                      onClick={() => cancelDocSync(doc.id)}
                                      variant="ghost"
                                      size="icon"
                                      title="Cancel Sync"
                                  >
                                      <XCircle size={20} />
                                  </Button>
                                )}
                                <Button
                                    onClick={() => {
                                        setEditingDoc(doc);
                                        setDocForm({
                                            title: doc.title,
                                            remote_path: doc.remote_path,
                                            year: doc.year || new Date().getFullYear(),
                                            timezone: doc.timezone || 'UTC',
                                            caldav_account_ids: doc.caldav_account_ids || (doc.caldav_account_id ? [doc.caldav_account_id] : []),
                                            subscription_ids: doc.subscription_ids || [],
                                            device_id: doc.device_id
                                        });
                                        setShowDocForm(true);
                                    }}
                                    variant="ghost"
                                    size="icon"
                                    title="Edit"
                                >
                                    <Settings size={20} />
                                </Button>
                                <Button
                                    onClick={() => deleteDoc(doc.id)}
                                    variant="ghost"
                                    size="icon"
                                    title="Delete"
                                >
                                    <Trash2 size={20} />
                                </Button>
                            </div>
                        </Card>
                    )})}
                </div>
            )}
          </div>
        )}

        {activeTab === 'devices' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-2xl font-bold">Devices</h2>
              <Button
                onClick={() => {
                    setEditingDevice(null);
                    setDeviceForm({
                      name: '',
                      host: '',
                      username: 'root',
                      password: '',
                      port: 22,
                      sync_when_connected: false,
                      backup_enabled: false,
                      backup_frequency_hours: 24,
                      allow_password_fallback: true,
                    });
                    setShowDeviceForm(true);
                }}
                className="gap-2"
              >
                <Plus size={18} />
                Add Device
              </Button>
            </div>

            <div className="grid gap-4">
                {devices.map(dev => {
                    const latestBackup = getLatestBackupForDevice(dev.id);
                    const backupRunning = !!manualBackupStatus[dev.id] || latestBackup?.status === 'running';
                    const backupCancelling = !!(latestBackup && cancellingBackupStatus[latestBackup.id]);
                    const latestProgress = latestBackup ? backupProgress[latestBackup.id] : null;
                    const diagnostics = backupDiagnosticsByDevice[dev.id];
                    const keyEnrolling = !!enrollKeyStatus[dev.id];
                    const docsForDevice = documents.filter((d) => d.device_id === dev.id);
                    const syncRunning = docsForDevice.some((d) => d.sync_status === 'syncing' || !!manualSyncStatus[d.id]);
                    const syncErrored = docsForDevice.some((d) => d.sync_status === 'error');
                    const connectionState = deviceStatus[dev.id] || 'disconnected';
                    return (
                    <Card key={dev.id} className="p-5 md:p-6 flex flex-col lg:flex-row justify-between items-start gap-4">
                        <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                                <Tablet size={18} />
                                <h3 className="font-bold">{dev.name}</h3>
                                <Badge variant={connectionState === 'connected' ? 'success' : connectionState === 'checking' ? 'default' : 'destructive'} className="gap-1">
                                  {connectionState === 'connected' && <Wifi size={12} />}
                                  {connectionState === 'disconnected' && <WifiOff size={12} />}
                                  {connectionState === 'checking' && <RefreshCw size={12} className="animate-spin" />}
                                  {connectionState === 'connected' ? 'Connected' : connectionState === 'checking' ? 'Checking' : 'Offline'}
                                </Badge>
                            </div>
                            <p className="text-sm text-stone-500 font-mono mt-1 break-all">{dev.username}@{dev.host}:{dev.port}</p>
                            {diagnostics && (
                              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                                <Badge variant={diagnostics.will_use_rsync ? 'success' : 'warning'}>
                                  Transfer: {diagnostics.expected_transfer_method.toUpperCase()}
                                </Badge>
                                <Badge variant={diagnostics.effective_auth === 'key' ? 'success' : diagnostics.effective_auth === 'password' ? 'warning' : 'destructive'}>
                                  Effective Auth: {diagnostics.effective_auth}
                                </Badge>
                                <Badge>
                                  Key Source: {diagnostics.has_fs_private_key ? 'filesystem' : diagnostics.has_db_private_key ? 'database' : 'none'}
                                </Badge>
                              </div>
                            )}
                            {diagnostics && (
                              <p className="text-[11px] text-stone-500 mt-1">{diagnostics.reason}</p>
                            )}
                            <div className="mt-3 flex items-center gap-2 text-xs">
                              <Badge variant={dev.auth_mode === 'key' ? 'success' : 'warning'}>
                                Auth: {dev.auth_mode === 'key' ? 'SSH key' : 'Password'}
                              </Badge>
                              {dev.auth_mode !== 'key' && (
                                <Button
                                  onClick={() => enrollDeviceKey(dev.id)}
                                  disabled={keyEnrolling}
                                  size="sm"
                                >
                                  {keyEnrolling ? 'Enrolling key…' : 'Enable fast backup (SSH key)'}
                                </Button>
                              )}
                            </div>
                            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                              <div className={`flex items-center gap-2 px-3 py-1 rounded-full border ${syncRunning ? 'bg-blue-50 border-blue-200 text-blue-700' : syncErrored ? 'bg-red-50 border-red-200 text-red-700' : dev.sync_when_connected ? 'bg-green-50 border-green-200 text-green-700' : 'bg-stone-50 border-stone-200 text-stone-700'}`}>
                                {syncRunning ? <RefreshCw size={12} className="animate-spin" /> : syncErrored ? <XCircle size={12} /> : <CheckCircle size={12} />}
                                <span>{syncRunning ? 'Sync: Running' : syncErrored ? 'Sync: Error' : dev.sync_when_connected ? 'Sync: Enabled' : 'Sync: Disabled'}</span>
                              </div>
                              <div className={`flex items-center gap-2 px-3 py-1 rounded-full border ${backupRunning ? (backupCancelling ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-blue-50 border-blue-200 text-blue-700') : latestBackup?.status === 'error' ? 'bg-red-50 border-red-200 text-red-700' : latestBackup?.status === 'partial' ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-stone-50 border-stone-200 text-stone-700'}`}>
                                {backupRunning ? <RefreshCw size={12} className="animate-spin" /> : latestBackup?.status === 'error' ? <XCircle size={12} /> : <CheckCircle size={12} />}
                                <span>Backup: {backupRunning ? (backupCancelling ? 'Cancelling…' : 'Running') : latestBackup?.status || (dev.backup_enabled ? `Every ${dev.backup_frequency_hours}h` : 'Disabled')}</span>
                                <span className="opacity-70">• Last: {formatDateTime(dev.last_backup_at)}</span>
                              </div>
                              <Button
                                onClick={() => runDeviceBackup(dev.id)}
                                disabled={backupRunning}
                                size="sm"
                                className="whitespace-nowrap"
                              >
                                {backupRunning ? 'Backing up…' : 'Run Backup Now'}
                              </Button>
                              {backupRunning && latestBackup && (
                                <Button
                                  onClick={() => cancelDeviceBackup(latestBackup.id)}
                                  disabled={backupCancelling}
                                  size="sm"
                                  variant="destructive"
                                >
                                  {backupCancelling ? 'Cancelling…' : 'Cancel Backup'}
                                </Button>
                              )}
                              {backupRunning && latestProgress && (
                                <div className="w-full mt-2 p-2 rounded border border-blue-200 bg-blue-50">
                                  <Progress value={latestProgress.percent || 0} className="bg-blue-100" />
                                  <p className="text-[11px] text-blue-700 mt-1">
                                    {latestProgress.phase} • {latestProgress.percent || 0}% • {(latestProgress.speedBytesPerSec ? (latestProgress.speedBytesPerSec / (1024 * 1024)).toFixed(2) : '0.00')} MB/s
                                    {latestProgress.message ? ` • ${latestProgress.message}` : ''}
                                  </p>
                                </div>
                              )}
                            </div>
                            <p className="text-xs text-stone-400 mt-2">Last connected: {new Date(dev.last_connected_at).toLocaleString()}</p>
                        </div>
                        <div className="flex gap-2 self-end lg:self-start shrink-0">
                            <Button
                                onClick={() => {
                                    setEditingDevice(dev);
                                    setDeviceForm({
                                        name: dev.name,
                                        host: dev.host,
                                        username: dev.username,
                                        password: '',
                                        port: dev.port,
                                        sync_when_connected: !!dev.sync_when_connected,
                                        backup_enabled: !!dev.backup_enabled,
                                        backup_frequency_hours: dev.backup_frequency_hours || 24,
                                        allow_password_fallback: dev.allow_password_fallback !== 0,
                                    }); // Don't show password
                                    setShowDeviceForm(true);
                                }}
                                variant="ghost"
                                size="icon"
                            >
                                <Settings size={20} />
                            </Button>
                            <Button
                                onClick={() => deleteDevice(dev.id)}
                                variant="ghost"
                                size="icon"
                            >
                                <Trash2 size={20} />
                            </Button>
                        </div>
                    </Card>
                )})}
            </div>

            <div className="rm-card bg-white p-4 rounded-2xl border border-stone-200 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="font-semibold">Backup Diagnostics</h3>
                  <p className="text-xs text-stone-500 mt-1">
                    rsync binary: {backupDiagnosticsRsyncAvailable === null ? 'unknown' : backupDiagnosticsRsyncAvailable ? 'available' : 'not available'}
                    {backupDiagnosticsAt ? ` • updated ${new Date(backupDiagnosticsAt).toLocaleTimeString()}` : ''}
                  </p>
                </div>
                <button
                  onClick={() => void loadBackupDiagnostics()}
                  disabled={backupDiagnosticsLoading}
                  className="px-3 py-1 text-xs rounded-full bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-60"
                >
                  {backupDiagnosticsLoading ? 'Refreshing…' : 'Refresh Diagnostics'}
                </button>
              </div>
              {backupDiagnosticsError && (
                <p className="text-xs text-red-600 mt-2">{backupDiagnosticsError}</p>
              )}
              <p className="text-xs text-stone-500 mt-2">
                Diagnostics are sourced from <span className="font-mono">/api/backups/diagnostics</span> and show the expected transfer mode per device.
              </p>
            </div>

            <div className="rm-card bg-white p-4 rounded-2xl border border-stone-200 shadow-sm">
              <h3 className="font-semibold mb-2">Recent Activity Log</h3>
              <div className="max-h-52 overflow-auto text-xs space-y-1">
                {infoLogs.length === 0 ? (
                  <p className="text-stone-500">No recent activity yet.</p>
                ) : infoLogs.slice().reverse().map((row, idx) => (
                  <div key={`${row.ts}-${idx}`} className="border-b border-stone-100 pb-1">
                    <span className="text-stone-400">{new Date(row.ts).toLocaleTimeString()} </span>
                    <span className={row.level === 'error' ? 'text-red-600' : row.level === 'warn' ? 'text-amber-600' : 'text-stone-700'}>{row.event}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-2xl font-bold">Calendars</h2>
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => {
                      setEditingAccount(null);
                      setAccountForm({ name: '', url: '', username: '', password: '', selected_calendars: [] });
                      setShowAccountForm(true);
                  }}
                  className="gap-2"
                >
                  <Plus size={18} />
                  Add CalDAV
                </Button>
                <Button
                  onClick={() => {
                    setEditingSubscription(null);
                    setSubscriptionForm({ name: '', url: '', owner_email: '', update_frequency_minutes: 30, enabled: true });
                    setShowSubscriptionForm(true);
                  }}
                  variant="secondary"
                  className="gap-2"
                >
                  <Plus size={18} />
                  Add Subscription
                </Button>
              </div>
            </div>

            <h3 className="text-lg font-semibold text-stone-700">CalDAV</h3>

            <div className="grid gap-4">
                {accounts.map(acc => {
                    const selected = safeParseJsonArray<{url: string, name: string}>(acc.selected_calendars, []);
                    const testStatus = accountTestStatus[acc.id];
                    return (
                        <Card key={acc.id} className="p-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                            <div>
                                <h3 className="font-bold">{acc.name}</h3>
                                <p className="text-sm text-stone-500">{acc.url}</p>
                                <p className="text-xs text-stone-400">{acc.username} • {selected.length} calendars selected</p>
                                {testStatus?.state === 'running' && <p className="text-xs text-blue-600 mt-1">Testing connection…</p>}
                                {testStatus?.state === 'success' && (
                                  <p className="text-xs text-green-600 mt-1">✓ {testStatus.message}{typeof testStatus.count === 'number' ? ` (${testStatus.count} events)` : ''}</p>
                                )}
                                {testStatus?.state === 'error' && <p className="text-xs text-red-600 mt-1">✕ {testStatus.message}</p>}
                            </div>
                            <div className="flex gap-2 self-end md:self-auto">
                                <Button
                                    onClick={() => testAccount(acc.id)}
                                    size="sm"
                                    variant="secondary"
                                >
                                    {testStatus?.state === 'running' ? 'Testing…' : 'Test'}
                                </Button>
                                <Button
                                    onClick={() => {
                                        setEditingAccount(acc);
                                        setAccountForm({ 
                                            name: acc.name,
                                            url: acc.url,
                                            username: acc.username,
                                            password: '',
                                            selected_calendars: selected
                                        });
                                        setShowAccountForm(true);
                                    }}
                                    variant="ghost"
                                    size="icon"
                                >
                                    <Settings size={20} />
                                </Button>
                                <Button
                                    onClick={() => deleteAccount(acc.id)}
                                    variant="ghost"
                                    size="icon"
                                >
                                    <Trash2 size={20} />
                                </Button>
                            </div>
                        </Card>
                    );
                })}
            </div>

            <h3 className="text-lg font-semibold text-stone-700 pt-2">Subscriptions</h3>
            <div className="grid gap-4">
              {subscriptions.length === 0 ? (
                <Card className="p-6 text-sm text-stone-500">
                  No subscriptions yet.
                </Card>
              ) : (
                subscriptions.map(sub => {
                  const syncStatus = subscriptionFetchStatus[sub.id];
                  return (
                  <Card key={sub.id} className="p-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                    <div>
                      <h3 className="font-bold">{sub.name}</h3>
                      {sub.owner_email && <p className="text-xs text-stone-400">Owner: {sub.owner_email}</p>}
                      <p className="text-sm text-stone-500">Updates every {sub.update_frequency_minutes} minutes</p>
                      <p className="text-xs text-stone-400">
                        {sub.last_success_at ? `Last success: ${new Date(sub.last_success_at).toLocaleString()}` : 'Not fetched yet'}
                      </p>
                      {sub.last_error && <p className="text-xs text-red-600 mt-1">{sub.last_error}</p>}
                      {syncStatus?.state === 'running' && <p className="text-xs text-blue-600 mt-1">Fetching now…</p>}
                      {syncStatus?.state === 'success' && (
                        <p className="text-xs text-green-600 mt-1">✓ {syncStatus.message}{typeof syncStatus.count === 'number' ? ` (${syncStatus.count} stored)` : ''}</p>
                      )}
                      {syncStatus?.state === 'error' && <p className="text-xs text-red-600 mt-1">✕ {syncStatus.message}</p>}
                    </div>
                    <div className="flex gap-2 self-end md:self-auto">
                      <Button
                        onClick={() => fetchSubscriptionNow(sub.id)}
                        size="sm"
                        variant="secondary"
                      >
                        {syncStatus?.state === 'running' ? 'Fetching…' : 'Fetch now'}
                      </Button>
                      <Button
                        onClick={() => {
                          setEditingSubscription(sub);
                          setSubscriptionForm({
                            name: sub.name,
                            url: '',
                            owner_email: sub.owner_email || '',
                            update_frequency_minutes: sub.update_frequency_minutes,
                            enabled: !!sub.enabled,
                          });
                          setShowSubscriptionForm(true);
                        }}
                        variant="ghost"
                        size="icon"
                      >
                        <Settings size={20} />
                      </Button>
                      <Button
                        onClick={() => deleteSubscription(sub.id)}
                        variant="ghost"
                        size="icon"
                      >
                        <Trash2 size={20} />
                      </Button>
                    </div>
                  </Card>
                )})
              )}
            </div>
          </div>
        )}
      </main>

      {/* Document Modal */}
      {showDocForm && (
        <div
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto"
            role="dialog"
            aria-modal="true"
            aria-labelledby="document-modal-title"
            onMouseDown={(e) => { if (e.target === e.currentTarget) setShowDocForm(false); }}
        >
            <div
                ref={docModalRef}
                className="bg-white rounded-2xl p-8 max-w-md w-full shadow-xl max-h-[calc(100vh-2rem)] overflow-y-auto"
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => trapFocusWithin(e, docModalRef.current)}
            >
                <h3 id="document-modal-title" className="text-xl font-bold mb-4">{editingDoc ? 'Edit Document' : 'New Document'}</h3>
                {modalError && (
                    <div className="mb-4 p-3 bg-red-50 text-red-700 rounded-lg text-sm flex items-center gap-2">
                        <XCircle size={16} />
                        {modalError}
                    </div>
                )}
                <form onSubmit={handleDocSubmit} className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium mb-1">Title</label>
                        <input 
                            type="text" 
                            required
                            className="w-full px-3 py-2 border rounded-lg"
                            value={docForm.title}
                            onChange={e => setDocForm({...docForm, title: e.target.value})}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Year</label>
                        <input 
                            type="number" 
                            required
                            className="w-full px-3 py-2 border rounded-lg"
                            value={docForm.year}
                            onChange={e => setDocForm({...docForm, year: parseInt(e.target.value)})}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Timezone</label>
                        <input 
                            type="text" 
                            required
                            placeholder="e.g. America/New_York"
                            className="w-full px-3 py-2 border rounded-lg"
                            value={docForm.timezone}
                            onChange={e => setDocForm({...docForm, timezone: e.target.value})}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Device</label>
                        <select 
                            required
                            className="w-full px-3 py-2 border rounded-lg"
                            value={docForm.device_id}
                            onChange={e => setDocForm({...docForm, device_id: e.target.value})}
                        >
                            <option value="">Select Device</option>
                            {devices.map(d => (
                                <option key={d.id} value={d.id}>{d.name}</option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Remote Path (on reMarkable)</label>
                        <input 
                            type="text" 
                            required
                            className="w-full px-3 py-2 border rounded-lg font-mono text-xs"
                            value={docForm.remote_path}
                            onChange={e => setDocForm({...docForm, remote_path: e.target.value})}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-2">CalDAV Accounts</label>
                        <div className="space-y-2 max-h-40 overflow-y-auto p-3 border rounded-lg bg-stone-50">
                            {accounts.length === 0 ? (
                                <p className="text-xs text-stone-500 italic">No accounts configured. Go to Settings first.</p>
                            ) : (
                                accounts.map(a => (
                                    <label key={a.id} className="flex items-center gap-2 cursor-pointer hover:bg-stone-100 p-1 rounded transition-colors">
                                        <input 
                                            type="checkbox"
                                            className="rounded border-stone-300 text-stone-900 focus:ring-stone-500"
                                            checked={docForm.caldav_account_ids.includes(a.id)}
                                            onChange={e => {
                                                const ids = e.target.checked 
                                                    ? [...docForm.caldav_account_ids, a.id]
                                                    : docForm.caldav_account_ids.filter(id => id !== a.id);
                                                setDocForm({...docForm, caldav_account_ids: ids});
                                            }}
                                        />
                                        <span className="text-sm">{a.name}</span>
                                    </label>
                                ))
                            )}
                        </div>
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-2">Subscriptions</label>
                        <div className="space-y-2 max-h-40 overflow-y-auto p-3 border rounded-lg bg-stone-50">
                            {subscriptions.length === 0 ? (
                                <p className="text-xs text-stone-500 italic">No subscriptions configured.</p>
                            ) : (
                                subscriptions.map(s => (
                                    <label key={s.id} className="flex items-center gap-2 cursor-pointer hover:bg-stone-100 p-1 rounded transition-colors">
                                        <input
                                            type="checkbox"
                                            className="rounded border-stone-300 text-stone-900 focus:ring-stone-500"
                                            checked={docForm.subscription_ids.includes(s.id)}
                                            onChange={e => {
                                                const ids = e.target.checked
                                                    ? [...docForm.subscription_ids, s.id]
                                                    : docForm.subscription_ids.filter(id => id !== s.id);
                                                setDocForm({ ...docForm, subscription_ids: ids });
                                            }}
                                        />
                                        <span className="text-sm">{s.name}</span>
                                    </label>
                                ))
                            )}
                        </div>
                    </div>
                    <div className="text-xs text-stone-500 bg-stone-50 border border-stone-200 rounded-lg p-3">
                        Automatic sync is controlled per device via the <span className="font-medium">Sync when connected</span> setting in the Devices tab.
                    </div>
                    <div className="flex justify-end gap-2 mt-6">
                        <button 
                            type="button"
                            onClick={() => setShowDocForm(false)}
                            className="px-4 py-2 text-stone-600 hover:bg-stone-100 rounded-lg"
                        >
                            Cancel
                        </button>
                        <button 
                            type="submit"
                            disabled={submitting}
                            className="px-4 py-2 bg-stone-900 text-white rounded-lg hover:bg-stone-800 disabled:opacity-50 flex items-center gap-2"
                        >
                            {submitting && <RefreshCw size={16} className="animate-spin" />}
                            Save
                        </button>
                    </div>
                </form>
            </div>
        </div>
      )}

      {/* Device Modal */}
      {showDeviceForm && (
        <div
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto"
            role="dialog"
            aria-modal="true"
            aria-labelledby="device-modal-title"
            onMouseDown={(e) => { if (e.target === e.currentTarget) setShowDeviceForm(false); }}
        >
            <div
                ref={deviceModalRef}
                className="bg-white rounded-2xl p-8 max-w-md w-full shadow-xl max-h-[calc(100vh-2rem)] overflow-y-auto"
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => trapFocusWithin(e, deviceModalRef.current)}
            >
                <h3 id="device-modal-title" className="text-xl font-bold mb-4">{editingDevice ? 'Edit Device' : 'New Device'}</h3>
                {modalError && (
                    <div className="mb-4 p-3 bg-red-50 text-red-700 rounded-lg text-sm flex items-center gap-2">
                        <XCircle size={16} />
                        {modalError}
                    </div>
                )}
                <form onSubmit={handleDeviceSubmit} className="space-y-4">
                    <div className="p-3 rounded-lg border border-stone-200 bg-stone-50">
                      <p className="text-xs uppercase tracking-wide text-stone-500 font-semibold mb-2">Connection</p>
                    {editingDevice && (
                      <div className="mb-3 text-xs">
                        <span className={`px-2 py-0.5 rounded-full border ${editingDevice.auth_mode === 'key' ? 'bg-green-50 border-green-200 text-green-700' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>
                          Current auth: {editingDevice.auth_mode === 'key' ? 'SSH key' : 'Password'}
                        </span>
                      </div>
                    )}
                    <div>
                        <label className="block text-sm font-medium mb-1">Name</label>
                        <input 
                            type="text" 
                            required
                            className="w-full px-3 py-2 border rounded-lg"
                            value={deviceForm.name}
                            onChange={e => setDeviceForm({...deviceForm, name: e.target.value})}
                            placeholder="My reMarkable"
                        />
                    </div>
                    <div className="grid grid-cols-3 gap-4">
                        <div className="col-span-2">
                            <label className="block text-sm font-medium mb-1">Host (IP)</label>
                            <input 
                                type="text" 
                                required
                                className="w-full px-3 py-2 border rounded-lg"
                                value={deviceForm.host}
                                onChange={e => setDeviceForm({...deviceForm, host: e.target.value})}
                                placeholder="10.11.99.1"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1">Port</label>
                            <input 
                                type="number" 
                                required
                                className="w-full px-3 py-2 border rounded-lg"
                                value={deviceForm.port}
                                onChange={e => setDeviceForm({...deviceForm, port: parseInt(e.target.value)})}
                            />
                        </div>
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Username</label>
                        <input 
                            type="text" 
                            required
                            className="w-full px-3 py-2 border rounded-lg"
                            value={deviceForm.username}
                            onChange={e => setDeviceForm({...deviceForm, username: e.target.value})}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Password</label>
                        <input 
                            type="password" 
                            className="w-full px-3 py-2 border rounded-lg"
                            value={deviceForm.password}
                            onChange={e => setDeviceForm({...deviceForm, password: e.target.value})}
                            placeholder={editingDevice ? "(Unchanged)" : "Required"}
                        />
                    </div>
                    </div>

                    <div className="p-3 rounded-lg border border-stone-200 bg-stone-50">
                      <p className="text-xs uppercase tracking-wide text-stone-500 font-semibold mb-2">Sync</p>
                    <div className="flex items-center gap-2">
                        <input
                            type="checkbox"
                            id="sync_when_connected"
                            checked={deviceForm.sync_when_connected}
                            onChange={e => setDeviceForm({ ...deviceForm, sync_when_connected: e.target.checked })}
                        />
                        <label htmlFor="sync_when_connected" className="text-sm font-medium">Sync when connected</label>
                    </div>
                    <p className="text-xs text-stone-500">Checks connection every 2 minutes. Auto-sync runs only if the last successful sync is at least 1 hour old.</p>
                    </div>

                    <div className="p-3 rounded-lg border border-stone-200 bg-stone-50">
                      <p className="text-xs uppercase tracking-wide text-stone-500 font-semibold mb-2">Backup</p>
                      <div className="flex items-center gap-2 mb-2">
                        <input
                          type="checkbox"
                          id="backup_enabled"
                          checked={deviceForm.backup_enabled}
                          onChange={e => setDeviceForm({ ...deviceForm, backup_enabled: e.target.checked })}
                        />
                        <label htmlFor="backup_enabled" className="text-sm font-medium">Enable scheduled backups</label>
                      </div>
                      <div>
                        <label className="block text-sm font-medium mb-1">Backup frequency (hours)</label>
                        <select
                          className="w-full px-3 py-2 border rounded-lg"
                          value={deviceForm.backup_frequency_hours}
                          onChange={e => setDeviceForm({ ...deviceForm, backup_frequency_hours: parseInt(e.target.value, 10) })}
                        >
                          {[6, 12, 24, 48, 72, 168].map((h) => (
                            <option key={h} value={h}>{h}h</option>
                          ))}
                        </select>
                      </div>
                      <p className="text-xs text-stone-500 mt-1">Backups run only when the device is reachable, and separately from sync.</p>
                      <div className="flex items-center gap-2 mt-2">
                        <input
                          type="checkbox"
                          id="allow_password_fallback"
                          checked={deviceForm.allow_password_fallback}
                          disabled={editingDevice?.auth_mode === 'key'}
                          onChange={e => setDeviceForm({ ...deviceForm, allow_password_fallback: e.target.checked })}
                        />
                        <label htmlFor="allow_password_fallback" className={`text-xs ${editingDevice?.auth_mode === 'key' ? 'text-stone-400' : 'text-stone-600'}`}>
                          Allow password fallback for manual connection checks
                        </label>
                      </div>
                      {editingDevice?.auth_mode === 'key' && (
                        <p className="text-xs text-stone-500 mt-1">Password credentials are removed after SSH key enrollment; fallback is unavailable in key mode.</p>
                      )}
                    </div>

                    <div className="flex justify-end gap-2 mt-6">
                        <button 
                            type="button"
                            onClick={() => setShowDeviceForm(false)}
                            className="px-4 py-2 text-stone-600 hover:bg-stone-100 rounded-lg"
                        >
                            Cancel
                        </button>
                        <button 
                            type="submit"
                            disabled={submitting}
                            className="px-4 py-2 bg-stone-900 text-white rounded-lg hover:bg-stone-800 disabled:opacity-50 flex items-center gap-2"
                        >
                            {submitting && <RefreshCw size={16} className="animate-spin" />}
                            {editingDevice ? 'Save & Test' : 'Create & Test'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
      )}

      {/* Account Modal */}
      {showAccountForm && (
        <div
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto"
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-modal-title"
            onMouseDown={(e) => { if (e.target === e.currentTarget) setShowAccountForm(false); }}
        >
            <div
                ref={accountModalRef}
                className="bg-white rounded-2xl p-8 max-w-md w-full shadow-xl max-h-[calc(100vh-2rem)] overflow-y-auto"
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => trapFocusWithin(e, accountModalRef.current)}
            >
                <h3 id="account-modal-title" className="text-xl font-bold mb-4">{editingAccount ? 'Edit Account' : 'New Account'}</h3>
                {modalError && (
                    <div className="mb-4 p-3 bg-red-50 text-red-700 rounded-lg text-sm flex items-center gap-2">
                        <XCircle size={16} />
                        {modalError}
                    </div>
                )}
                <form onSubmit={handleAccountSubmit} className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium mb-1">Name</label>
                        <input 
                            type="text" 
                            required
                            className="w-full px-3 py-2 border rounded-lg"
                            value={accountForm.name}
                            onChange={e => setAccountForm({...accountForm, name: e.target.value})}
                            placeholder="My Calendar"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">CalDAV URL</label>
                        <input 
                            type="text" 
                            required
                            className="w-full px-3 py-2 border rounded-lg"
                            value={accountForm.url}
                            onChange={e => setAccountForm({...accountForm, url: e.target.value})}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Username</label>
                        <input 
                            type="text" 
                            required
                            className="w-full px-3 py-2 border rounded-lg"
                            value={accountForm.username}
                            onChange={e => setAccountForm({...accountForm, username: e.target.value})}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Password / Token</label>
                        <div className="flex gap-2">
                            <input 
                                type="password" 
                                required={!editingAccount}
                                className="flex-1 px-3 py-2 border rounded-lg"
                                value={accountForm.password}
                                onChange={e => setAccountForm({...accountForm, password: e.target.value})}
                                placeholder={editingAccount ? "(Unchanged)" : ""}
                            />
                            <button 
                                type="button"
                                onClick={handleDiscover}
                                disabled={discovering}
                                className="px-3 py-2 bg-stone-100 text-stone-900 border border-stone-200 rounded-lg text-sm font-medium hover:bg-stone-200 disabled:opacity-50 flex items-center gap-1"
                            >
                                {discovering ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />}
                                Discover
                            </button>
                        </div>
                    </div>

                    {discoveredCalendars.length > 0 && (
                        <div className="bg-stone-50 p-3 rounded-lg border border-stone-200">
                            <label className="block text-xs font-bold text-stone-500 uppercase mb-2">Discovered Calendars</label>
                            <div className="space-y-1 max-h-40 overflow-y-auto">
                                {discoveredCalendars.map(cal => {
                                    const isSelected = accountForm.selected_calendars.some(c => c.url === cal.url);
                                    return (
                                        <div
                                            key={cal.url}
                                            className="flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-white rounded border border-transparent hover:border-stone-200 group"
                                        >
                                            <input 
                                                type="checkbox"
                                                checked={isSelected}
                                                onChange={(e) => {
                                                    if (e.target.checked) {
                                                        setAccountForm({
                                                            ...accountForm,
                                                            selected_calendars: [...accountForm.selected_calendars, cal]
                                                        });
                                                    } else {
                                                        setAccountForm({
                                                            ...accountForm,
                                                            selected_calendars: accountForm.selected_calendars.filter(c => c.url !== cal.url)
                                                        });
                                                    }
                                                }}
                                                className="rounded"
                                            />
                                            <span className="truncate flex-1">{cal.name}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {accountForm.selected_calendars.length > 0 && discoveredCalendars.length === 0 && (
                        <div className="bg-stone-50 p-3 rounded-lg border border-stone-200">
                            <label className="block text-xs font-bold text-stone-500 uppercase mb-2">Selected Calendars ({accountForm.selected_calendars.length})</label>
                            <div className="space-y-1 max-h-40 overflow-y-auto">
                                {accountForm.selected_calendars.map(cal => (
                                    <div key={cal.url} className="flex items-center justify-between text-sm px-2 py-1">
                                        <span className="truncate">{cal.name}</span>
                                        <button 
                                            type="button"
                                            onClick={() => setAccountForm({
                                                ...accountForm,
                                                selected_calendars: accountForm.selected_calendars.filter(c => c.url !== cal.url)
                                            })}
                                            className="text-stone-400 hover:text-red-500"
                                        >
                                            <Trash2 size={12} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    <div className="flex justify-end gap-2 mt-6">
                        <button 
                            type="button"
                            onClick={() => setShowAccountForm(false)}
                            className="px-4 py-2 text-stone-600 hover:bg-stone-100 rounded-lg"
                        >
                            Cancel
                        </button>
                        <button 
                            type="submit"
                            disabled={submitting}
                            className="px-4 py-2 bg-stone-900 text-white rounded-lg hover:bg-stone-800 disabled:opacity-50 flex items-center gap-2"
                        >
                            {submitting && <RefreshCw size={16} className="animate-spin" />}
                            Save
                        </button>
                    </div>
                </form>
            </div>
        </div>
      )}

      {/* Subscription Modal */}
      {showSubscriptionForm && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-labelledby="subscription-modal-title"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setShowSubscriptionForm(false); }}
        >
          <div
            ref={subscriptionModalRef}
            className="bg-white rounded-2xl p-8 max-w-md w-full shadow-xl max-h-[calc(100vh-2rem)] overflow-y-auto"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => trapFocusWithin(e, subscriptionModalRef.current)}
          >
            <h3 id="subscription-modal-title" className="text-xl font-bold mb-4">{editingSubscription ? 'Edit Subscription' : 'New Subscription'}</h3>
            {modalError && (
              <div className="mb-4 p-3 bg-red-50 text-red-700 rounded-lg text-sm flex items-center gap-2">
                <XCircle size={16} />
                {modalError}
              </div>
            )}
            <form onSubmit={handleSubscriptionSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Name</label>
                <input
                  type="text"
                  required
                  className="w-full px-3 py-2 border rounded-lg"
                  value={subscriptionForm.name}
                  onChange={e => setSubscriptionForm({ ...subscriptionForm, name: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">URL (.ics / iCal)</label>
                <input
                  type="url"
                  required={!editingSubscription}
                  className="w-full px-3 py-2 border rounded-lg"
                  placeholder={editingSubscription ? '(Unchanged unless replaced)' : 'https://example.com/calendar.ics'}
                  value={subscriptionForm.url}
                  onChange={e => setSubscriptionForm({ ...subscriptionForm, url: e.target.value })}
                />
                <p className="text-xs text-stone-500 mt-1">Secret subscription URLs are treated as credentials and stored encrypted.</p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Owner email (for invite status matching)</label>
                <input
                  type="email"
                  className="w-full px-3 py-2 border rounded-lg"
                  placeholder="you@gmail.com"
                  value={subscriptionForm.owner_email}
                  onChange={e => setSubscriptionForm({ ...subscriptionForm, owner_email: e.target.value })}
                />
                <p className="text-xs text-stone-500 mt-1">For Google iCal feeds, this lets us match your attendee PARTSTAT only.</p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Update frequency (minutes)</label>
                <input
                  type="number"
                  min={15}
                  max={1440}
                  required
                  className="w-full px-3 py-2 border rounded-lg"
                  value={subscriptionForm.update_frequency_minutes}
                  onChange={e => setSubscriptionForm({ ...subscriptionForm, update_frequency_minutes: parseInt(e.target.value || '30') })}
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="subscription_enabled"
                  checked={subscriptionForm.enabled}
                  onChange={e => setSubscriptionForm({ ...subscriptionForm, enabled: e.target.checked })}
                />
                <label htmlFor="subscription_enabled" className="text-sm font-medium">Enabled</label>
              </div>

              <div className="flex justify-end gap-2 mt-6">
                <button
                  type="button"
                  onClick={() => setShowSubscriptionForm(false)}
                  className="px-4 py-2 text-stone-600 hover:bg-stone-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 bg-stone-900 text-white rounded-lg hover:bg-stone-800 disabled:opacity-50 flex items-center gap-2"
                >
                  {submitting && <RefreshCw size={16} className="animate-spin" />}
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {confirmState.open && (
        <div
          className="fixed inset-0 z-[60] bg-black/40 p-4 flex items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeConfirm();
          }}
        >
          <Card className="w-full max-w-md" onMouseDown={(e) => e.stopPropagation()}>
            <CardContent className="p-6 space-y-4">
              <h3 id="confirm-title" className="text-lg font-semibold">{confirmState.title}</h3>
              <p className="text-sm text-stone-600">{confirmState.description}</p>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={closeConfirm} disabled={confirmSubmitting}>Cancel</Button>
                <Button
                  variant="destructive"
                  disabled={confirmSubmitting}
                  onClick={async () => {
                    if (!confirmState.onConfirm) return;
                    setConfirmSubmitting(true);
                    try {
                      await confirmState.onConfirm();
                      closeConfirm();
                    } catch (err: any) {
                      pushToast('error', err?.response?.data?.error || err?.message || 'Action failed');
                    } finally {
                      setConfirmSubmitting(false);
                    }
                  }}
                >
                  {confirmSubmitting ? 'Working…' : 'Confirm'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-[70] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={cn(
                'rounded-xl border px-4 py-3 text-sm shadow-md backdrop-blur',
                toast.kind === 'error'
                  ? 'border-red-200 bg-red-50/95 text-red-700'
                  : toast.kind === 'success'
                    ? 'border-emerald-200 bg-emerald-50/95 text-emerald-700'
                    : 'border-stone-200 bg-white/95 text-stone-700',
              )}
            >
              {toast.message}
            </div>
          ))}
        </div>
      )}
      </>
      )}
    </div>
  );
}
  const getSyncPhaseLabel = (phase?: Document['sync_phase']) => {
    switch (phase) {
      case 'queued': return 'Queued';
      case 'preparing': return 'Preparing sync';
      case 'generating_pdf': return 'Generating PDF';
      case 'uploading': return 'Uploading to device';
      case 'finalizing': return 'Finalizing';
      case 'done': return 'Complete';
      case 'cancelled': return 'Cancelled';
      case 'error': return 'Failed';
      default: return 'Syncing';
    }
  };
