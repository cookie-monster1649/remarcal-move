import React, { useState, useEffect } from 'react';
import { Calendar, Settings, Plus, Trash2, RefreshCw, CheckCircle, XCircle, Clock, Tablet, Wifi, WifiOff, Download, LogOut, Shield } from 'lucide-react';
import axios from 'axios';

axios.defaults.withCredentials = true;

// Types
interface Document {
  id: string;
  title: string;
  type: string;
  remote_path: string;
  last_synced_at: string;
  sync_status: 'idle' | 'checking' | 'queued' | 'syncing' | 'error';
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

interface InfoLogEvent {
  ts: string;
  level: 'info' | 'warn' | 'error';
  event: string;
  [key: string]: any;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'library' | 'settings' | 'devices'>('library');
  const [documents, setDocuments] = useState<Document[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [backups, setBackups] = useState<DeviceBackup[]>([]);
  const [backupProgress, setBackupProgress] = useState<Record<string, BackupProgress>>({});
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
    const interval = setInterval(fetchData, 10000); // Poll every 10s
    return () => clearInterval(interval);
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated) return;
    if (devices.length > 0) {
        checkConnections();
        const interval = setInterval(checkConnections, 30000); // Check every 30s
        return () => clearInterval(interval);
    }
  }, [authenticated, devices.length]); // Re-run when devices list changes

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
    if (!confirm('Are you sure?')) return;
    try {
      await axios.delete(`/api/library/${id}`);
      fetchData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const deleteAccount = async (id: string) => {
    if (!confirm('Are you sure?')) return;
    try {
      await axios.delete(`/api/settings/${id}`);
      fetchData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const deleteDevice = async (id: string) => {
    if (!confirm('Are you sure?')) return;
    try {
      await axios.delete(`/api/devices/${id}`);
      fetchData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const deleteSubscription = async (id: string) => {
    if (!confirm('Are you sure?')) return;
    try {
      await axios.delete(`/api/settings/subscriptions/${id}`);
      fetchData();
    } catch (err: any) {
      alert(err.message);
    }
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
      alert(err.response?.data?.error || err.message || 'Failed to sync');
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
      alert(err.response?.data?.error || err.message || 'Failed to cancel sync');
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
      alert(err.response?.data?.error || err.message || 'Failed to start backup');
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
      alert(err.response?.data?.error || err.message || 'Failed to cancel backup');
    }
  };

  const enrollDeviceKey = async (deviceId: string) => {
    setEnrollKeyStatus(prev => ({ ...prev, [deviceId]: true }));
    try {
      await axios.post(`/api/devices/${deviceId}/enroll-key`);
      await fetchData();
    } catch (err: any) {
      alert(err.response?.data?.error || err.message || 'Failed to enroll SSH key');
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

    void poll();
    const interval = setInterval(() => {
      void poll();
    }, 2000);
    return () => clearInterval(interval);
  }, [authenticated, activeTab, backups]);

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
      alert(err.response?.data?.error || err.message || 'Failed to download PDF');
    }
  };

  return (
    <div className="remarkable-ui min-h-screen bg-stone-100 text-stone-900 font-sans">
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
              <label className="block text-sm font-medium mb-1">Admin password</label>
              <input
                type="password"
                className="w-full px-3 py-2 border rounded-lg"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                required
              />
            </div>
            <button type="submit" disabled={authSubmitting} className="w-full px-4 py-2 bg-stone-900 text-white rounded-lg hover:bg-stone-800 disabled:opacity-50">
              {authSubmitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      ) : (
      <>
      <header className="remarkable-header bg-white border-b border-stone-200 p-4 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="rm-brand-mark w-8 h-8 bg-stone-900 text-white flex items-center justify-center rounded-lg">
              <Calendar size={20} />
            </div>
            <h1 className="rm-brand-title text-xl font-bold tracking-tight">remarcal-move</h1>
            
            {/* Device Status Indicators (per device) */}
            {devices.length > 0 && (
                <div className="ml-4 flex flex-wrap items-center gap-2 text-xs">
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
                          className="flex items-center gap-2 px-3 py-1 bg-stone-50 rounded-full border border-stone-200 text-xs hover:bg-stone-100 disabled:opacity-70"
                          title={`Click to test connection: ${dev.name}`}
                        >
                          {isChecking ? (
                            <RefreshCw size={14} className="animate-spin text-stone-400" />
                          ) : isConnected ? (
                            <Wifi size={14} className="text-green-500" />
                          ) : (
                            <WifiOff size={14} className="text-red-500" />
                          )}
                          <span className="font-bold text-stone-800">{dev.name}</span>
                          <span className="text-stone-600">
                            {isChecking ? 'Checking...' : isConnected ? 'Connected' : 'Disconnected'}
                          </span>
                        </button>
                      );
                    })}
                </div>
            )}
          </div>
          <nav className="flex gap-4">
            <button 
              onClick={() => setActiveTab('library')}
              className={`rm-nav-button ${activeTab === 'library' ? 'rm-nav-active' : ''} px-3 py-2 rounded-lg text-sm font-medium ${activeTab === 'library' ? 'bg-stone-100 text-stone-900' : 'text-stone-500 hover:text-stone-900'}`}
            >
              Library
            </button>
            <button 
              onClick={() => setActiveTab('devices')}
              className={`rm-nav-button ${activeTab === 'devices' ? 'rm-nav-active' : ''} px-3 py-2 rounded-lg text-sm font-medium ${activeTab === 'devices' ? 'bg-stone-100 text-stone-900' : 'text-stone-500 hover:text-stone-900'}`}
            >
              Devices
            </button>
            <button 
              onClick={() => setActiveTab('settings')}
              className={`rm-nav-button ${activeTab === 'settings' ? 'rm-nav-active' : ''} px-3 py-2 rounded-lg text-sm font-medium ${activeTab === 'settings' ? 'bg-stone-100 text-stone-900' : 'text-stone-500 hover:text-stone-900'}`}
            >
              Calendars
            </button>
            <button
              onClick={handleLogout}
              className="px-3 py-2 rounded-lg text-sm font-medium text-stone-500 hover:text-stone-900 flex items-center gap-1"
              title="Logout"
            >
              <LogOut size={14} />
              Logout
            </button>
          </nav>
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-6">
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
              <button 
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
                className="rm-button-primary flex items-center px-4 py-2 bg-stone-900 text-white rounded-lg hover:bg-stone-800"
              >
                <Plus size={18} className="mr-2" />
                Add Document
              </button>
            </div>

            {documents.length === 0 ? (
                <div className="rm-card text-center py-12 text-stone-500 bg-white rounded-2xl border border-stone-200">
                    No documents found. Create one to get started.
                </div>
            ) : (
                <div className="grid gap-4">
                    {documents.map(doc => {
                        const isSyncing = doc.sync_status === 'syncing' || !!manualSyncStatus[doc.id];
                        const isQueued = doc.sync_status === 'queued';
                        return (
                        <div key={doc.id} className="rm-card bg-white p-6 rounded-2xl border border-stone-200 shadow-sm flex flex-col md:flex-row justify-between gap-4">
                            <div className="flex-1">
                                <div className="flex items-center gap-2 mb-1">
                                    <h3 className="font-bold text-lg">{doc.title}</h3>
                                    {isSyncing && <RefreshCw size={14} className="animate-spin text-blue-500" />}
                                    {isQueued && <Clock size={14} className="text-amber-600" />}
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
                                    {isQueued && (
                                        <span className="text-amber-700">Queued (waiting for backup/device lock)</span>
                                    )}
                                </div>
                                {doc.last_error && (
                                    <p className="text-xs text-red-600 mt-2 bg-red-50 p-2 rounded">Error: {doc.last_error}</p>
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => downloadDocPdf(doc)}
                                    className="p-2 text-stone-500 hover:text-stone-900 hover:bg-stone-100 rounded-lg"
                                    title="Download PDF"
                                >
                                    <Download size={20} />
                                </button>
                                <button 
                                    onClick={() => syncDoc(doc.id)}
                                    disabled={isSyncing}
                                    className="p-2 text-stone-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg disabled:opacity-50"
                                    title="Sync Now"
                                >
                                    <RefreshCw size={20} className={isSyncing ? 'animate-spin' : ''} />
                                </button>
                                {(isSyncing || isQueued) && (
                                  <button
                                      onClick={() => cancelDocSync(doc.id)}
                                      className="p-2 text-stone-500 hover:text-amber-700 hover:bg-amber-50 rounded-lg"
                                      title="Cancel Sync"
                                  >
                                      <XCircle size={20} />
                                  </button>
                                )}
                                <button 
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
                                    className="p-2 text-stone-500 hover:text-stone-900 hover:bg-stone-100 rounded-lg"
                                    title="Edit"
                                >
                                    <Settings size={20} />
                                </button>
                                <button 
                                    onClick={() => deleteDoc(doc.id)}
                                    className="p-2 text-stone-500 hover:text-red-600 hover:bg-red-50 rounded-lg"
                                    title="Delete"
                                >
                                    <Trash2 size={20} />
                                </button>
                            </div>
                        </div>
                    )})}
                </div>
            )}
          </div>
        )}

        {activeTab === 'devices' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-2xl font-bold">Devices</h2>
              <button 
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
                className="rm-button-primary flex items-center px-4 py-2 bg-stone-900 text-white rounded-lg hover:bg-stone-800"
              >
                <Plus size={18} className="mr-2" />
                Add Device
              </button>
            </div>

            <div className="grid gap-4">
                {devices.map(dev => {
                    const latestBackup = getLatestBackupForDevice(dev.id);
                    const backupRunning = !!manualBackupStatus[dev.id] || latestBackup?.status === 'running';
                    const backupCancelling = !!(latestBackup && cancellingBackupStatus[latestBackup.id]);
                    const latestProgress = latestBackup ? backupProgress[latestBackup.id] : null;
                    const keyEnrolling = !!enrollKeyStatus[dev.id];
                    const docsForDevice = documents.filter((d) => d.device_id === dev.id);
                    const syncRunning = docsForDevice.some((d) => d.sync_status === 'syncing' || !!manualSyncStatus[d.id]);
                    const syncErrored = docsForDevice.some((d) => d.sync_status === 'error');
                    return (
                    <div key={dev.id} className="rm-card bg-white p-6 rounded-2xl border border-stone-200 shadow-sm flex justify-between items-start gap-4">
                        <div>
                            <div className="flex items-center gap-2">
                                <Tablet size={18} />
                                <h3 className="font-bold">{dev.name}</h3>
                                {deviceStatus[dev.id] === 'connected' && <Wifi size={14} className="text-green-500" title="Connected" />}
                                {deviceStatus[dev.id] === 'disconnected' && <WifiOff size={14} className="text-red-500" title="Disconnected" />}
                                {deviceStatus[dev.id] === 'checking' && <RefreshCw size={14} className="animate-spin text-stone-400" title="Checking..." />}
                            </div>
                            <p className="text-sm text-stone-500 font-mono mt-1">{dev.username}@{dev.host}:{dev.port}</p>
                            <div className="mt-2 flex items-center gap-2 text-xs">
                              <span className={`px-2 py-0.5 rounded-full border ${dev.auth_mode === 'key' ? 'bg-green-50 border-green-200 text-green-700' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>
                                Auth: {dev.auth_mode === 'key' ? 'SSH key' : 'Password'}
                              </span>
                              {dev.auth_mode !== 'key' && (
                                <button
                                  onClick={() => enrollDeviceKey(dev.id)}
                                  disabled={keyEnrolling}
                                  className="px-2 py-0.5 rounded-full bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-60"
                                >
                                  {keyEnrolling ? 'Enrolling key…' : 'Enable fast backup (SSH key)'}
                                </button>
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
                              <button
                                onClick={() => runDeviceBackup(dev.id)}
                                disabled={backupRunning}
                                className="px-3 py-1 text-xs rounded-full bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-60"
                              >
                                {backupRunning ? 'Backing up…' : 'Run Backup Now'}
                              </button>
                              {backupRunning && latestBackup && (
                                <button
                                  onClick={() => cancelDeviceBackup(latestBackup.id)}
                                  disabled={backupCancelling}
                                  className="px-3 py-1 text-xs rounded-full bg-red-600 text-white hover:bg-red-500 disabled:opacity-60"
                                >
                                  {backupCancelling ? 'Cancelling…' : 'Cancel Backup'}
                                </button>
                              )}
                              {backupRunning && latestProgress && (
                                <div className="w-full mt-2 p-2 rounded border border-blue-200 bg-blue-50">
                                  <div className="h-2 bg-blue-100 rounded overflow-hidden">
                                    <div className="h-2 bg-blue-500" style={{ width: `${Math.max(0, Math.min(100, latestProgress.percent || 0))}%` }} />
                                  </div>
                                  <p className="text-[11px] text-blue-700 mt-1">
                                    {latestProgress.phase} • {latestProgress.percent || 0}% • {(latestProgress.speedBytesPerSec ? (latestProgress.speedBytesPerSec / (1024 * 1024)).toFixed(2) : '0.00')} MB/s
                                    {latestProgress.message ? ` • ${latestProgress.message}` : ''}
                                  </p>
                                </div>
                              )}
                            </div>
                            <p className="text-xs text-stone-400 mt-2">Last connected: {new Date(dev.last_connected_at).toLocaleString()}</p>
                        </div>
                        <div className="flex gap-2">
                            <button 
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
                                className="p-2 text-stone-500 hover:text-stone-900 hover:bg-stone-100 rounded-lg"
                            >
                                <Settings size={20} />
                            </button>
                            <button 
                                onClick={() => deleteDevice(dev.id)}
                                className="p-2 text-stone-500 hover:text-red-600 hover:bg-red-50 rounded-lg"
                            >
                                <Trash2 size={20} />
                            </button>
                        </div>
                    </div>
                )})}
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
                <button 
                  onClick={() => {
                      setEditingAccount(null);
                      setAccountForm({ name: '', url: '', username: '', password: '', selected_calendars: [] });
                      setShowAccountForm(true);
                  }}
                  className="rm-button-primary flex items-center px-4 py-2 bg-stone-900 text-white rounded-lg hover:bg-stone-800"
                >
                  <Plus size={18} className="mr-2" />
                  Add CalDAV
                </button>
                <button
                  onClick={() => {
                    setEditingSubscription(null);
                    setSubscriptionForm({ name: '', url: '', owner_email: '', update_frequency_minutes: 30, enabled: true });
                    setShowSubscriptionForm(true);
                  }}
                  className="rm-button-secondary flex items-center px-4 py-2 bg-stone-800 text-white rounded-lg hover:bg-stone-700"
                >
                  <Plus size={18} className="mr-2" />
                  Add Subscription
                </button>
              </div>
            </div>

            <h3 className="text-lg font-semibold text-stone-700">CalDAV</h3>

            <div className="grid gap-4">
                {accounts.map(acc => {
                    const selected = JSON.parse(acc.selected_calendars || '[]');
                    const testStatus = accountTestStatus[acc.id];
                    return (
                        <div key={acc.id} className="rm-card bg-white p-6 rounded-2xl border border-stone-200 shadow-sm flex justify-between items-center">
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
                            <div className="flex gap-2">
                                <button 
                                    onClick={() => testAccount(acc.id)}
                                    className="px-3 py-2 text-xs text-stone-700 bg-stone-100 hover:bg-stone-200 rounded-lg"
                                >
                                    {testStatus?.state === 'running' ? 'Testing…' : 'Test'}
                                </button>
                                <button 
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
                                    className="p-2 text-stone-500 hover:text-stone-900 hover:bg-stone-100 rounded-lg"
                                >
                                    <Settings size={20} />
                                </button>
                                <button 
                                    onClick={() => deleteAccount(acc.id)}
                                    className="p-2 text-stone-500 hover:text-red-600 hover:bg-red-50 rounded-lg"
                                >
                                    <Trash2 size={20} />
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>

            <h3 className="text-lg font-semibold text-stone-700 pt-2">Subscriptions</h3>
            <div className="grid gap-4">
              {subscriptions.length === 0 ? (
                <div className="rm-card bg-white p-6 rounded-2xl border border-stone-200 text-sm text-stone-500">
                  No subscriptions yet.
                </div>
              ) : (
                subscriptions.map(sub => {
                  const syncStatus = subscriptionFetchStatus[sub.id];
                  return (
                  <div key={sub.id} className="rm-card bg-white p-6 rounded-2xl border border-stone-200 shadow-sm flex justify-between items-center">
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
                    <div className="flex gap-2">
                      <button
                        onClick={() => fetchSubscriptionNow(sub.id)}
                        className="px-3 py-2 text-xs text-stone-700 bg-stone-100 hover:bg-stone-200 rounded-lg"
                      >
                        {syncStatus?.state === 'running' ? 'Fetching…' : 'Fetch now'}
                      </button>
                      <button
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
                        className="p-2 text-stone-500 hover:text-stone-900 hover:bg-stone-100 rounded-lg"
                      >
                        <Settings size={20} />
                      </button>
                      <button
                        onClick={() => deleteSubscription(sub.id)}
                        className="p-2 text-stone-500 hover:text-red-600 hover:bg-red-50 rounded-lg"
                      >
                        <Trash2 size={20} />
                      </button>
                    </div>
                  </div>
                )})
              )}
            </div>
          </div>
        )}
      </main>

      {/* Document Modal */}
      {showDocForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl p-8 max-w-md w-full shadow-xl max-h-[90vh] overflow-y-auto">
                <h3 className="text-xl font-bold mb-4">{editingDoc ? 'Edit Document' : 'New Document'}</h3>
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl p-8 max-w-md w-full shadow-xl">
                <h3 className="text-xl font-bold mb-4">{editingDevice ? 'Edit Device' : 'New Device'}</h3>
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
                    <p className="text-xs text-stone-500">Checks every 2 minutes and syncs linked documents when this device is reachable.</p>
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl p-8 max-w-md w-full shadow-xl">
                <h3 className="text-xl font-bold mb-4">{editingAccount ? 'Edit Account' : 'New Account'}</h3>
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-8 max-w-md w-full shadow-xl">
            <h3 className="text-xl font-bold mb-4">{editingSubscription ? 'Edit Subscription' : 'New Subscription'}</h3>
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
      </>
      )}
    </div>
  );
}
