import React, { useState, useEffect } from 'react';
import { Calendar, Settings, Upload, Plus, Trash2, RefreshCw, FileText, CheckCircle, XCircle, Clock, Tablet, Wifi, WifiOff } from 'lucide-react';
import axios from 'axios';

// Types
interface Document {
  id: string;
  title: string;
  type: string;
  remote_path: string;
  sync_enabled: number;
  sync_schedule: string;
  last_synced_at: string;
  sync_status: 'idle' | 'syncing' | 'error';
  last_error: string;
  year: number;
  caldav_account_id: string;
  device_id: string;
}

interface Account {
  id: string;
  name: string;
  url: string;
  username: string;
  selected_calendars: string; // JSON string
}

interface Device {
  id: string;
  name: string;
  host: string;
  username: string;
  port: number;
  last_connected_at: string;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'library' | 'settings' | 'devices'>('library');
  const [documents, setDocuments] = useState<Document[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [discoveredCalendars, setDiscoveredCalendars] = useState<{url: string, name: string}[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [deviceStatus, setDeviceStatus] = useState<Record<string, 'connected' | 'disconnected' | 'checking'>>({});

  // Forms state
  const [showDocForm, setShowDocForm] = useState(false);
  const [editingDoc, setEditingDoc] = useState<Document | null>(null);
  const [docForm, setDocForm] = useState({
    title: '',
    remote_path: '/home/root/.local/share/remarkable/xochitl/calendar.pdf',
    sync_enabled: false,
    sync_schedule: '0 0 * * *', // Daily at midnight
    year: new Date().getFullYear(),
    caldav_account_id: '',
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

  const [showDeviceForm, setShowDeviceForm] = useState(false);
  const [editingDevice, setEditingDevice] = useState<Device | null>(null);
  const [deviceForm, setDeviceForm] = useState({
    name: '',
    host: '',
    username: 'root',
    password: '',
    port: 22
  });

  const fetchData = async () => {
    setLoading(true);
    try {
      const [docsRes, accountsRes, devicesRes] = await Promise.all([
        axios.get('/api/library'),
        axios.get('/api/settings'),
        axios.get('/api/devices')
      ]);
      
      // Defensive check: ensure data is an array
      const docsData = Array.isArray(docsRes.data) ? docsRes.data : (docsRes.data.documents || []);
      const accountsData = Array.isArray(accountsRes.data) ? accountsRes.data : [];
      const devicesData = Array.isArray(devicesRes.data) ? devicesRes.data : [];
      
      setDocuments(docsData);
      setAccounts(accountsData);
      setDevices(devicesData);
      setError(null);
    } catch (err: any) {
      setError(err.response?.data?.error || err.message);
      if (err.response?.status === 401) {
          // Browser handles basic auth prompt usually, but if not:
          // window.location.reload();
      }
    } finally {
      setLoading(false);
    }
  };

  // Check connection for all devices
  const checkConnections = async () => {
    if (devices.length === 0) return;
    
    const newStatus = { ...deviceStatus };
    
    await Promise.all(devices.map(async (dev) => {
        newStatus[dev.id] = 'checking';
        setDeviceStatus({ ...newStatus });
        try {
            await axios.post(`/api/devices/${dev.id}/check`);
            newStatus[dev.id] = 'connected';
        } catch (e) {
            newStatus[dev.id] = 'disconnected';
        }
    }));
    
    setDeviceStatus(newStatus);
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000); // Poll every 10s
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (devices.length > 0) {
        checkConnections();
        const interval = setInterval(checkConnections, 30000); // Check every 30s
        return () => clearInterval(interval);
    }
  }, [devices.length]); // Re-run when devices list changes

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
      setDeviceForm({ name: '', host: '', username: 'root', password: '', port: 22 });
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

  const syncDoc = async (id: string) => {
    try {
      await axios.post(`/api/library/${id}/sync`);
      fetchData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  return (
    <div className="min-h-screen bg-stone-100 text-stone-900 font-sans">
      <header className="bg-white border-b border-stone-200 p-4 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-stone-900 text-white flex items-center justify-center rounded-lg">
              <Calendar size={20} />
            </div>
            <h1 className="text-xl font-bold tracking-tight">Remarcal</h1>
            
            {/* Device Status Indicator (Summary) */}
            {devices.length > 0 && (
                <div className="ml-4 flex items-center gap-2 px-3 py-1 bg-stone-50 rounded-full border border-stone-200 text-xs">
                    {Object.values(deviceStatus).some(s => s === 'connected') ? (
                        <>
                            <Wifi size={14} className="text-green-500" />
                            <span className="text-stone-600">Connected</span>
                        </>
                    ) : Object.values(deviceStatus).some(s => s === 'checking') ? (
                        <>
                            <RefreshCw size={14} className="animate-spin text-stone-400" />
                            <span className="text-stone-500">Checking...</span>
                        </>
                    ) : (
                        <>
                            <WifiOff size={14} className="text-red-500" />
                            <span className="text-stone-600">Disconnected</span>
                        </>
                    )}
                </div>
            )}
          </div>
          <nav className="flex gap-4">
            <button 
              onClick={() => setActiveTab('library')}
              className={`px-3 py-2 rounded-lg text-sm font-medium ${activeTab === 'library' ? 'bg-stone-100 text-stone-900' : 'text-stone-500 hover:text-stone-900'}`}
            >
              Library
            </button>
            <button 
              onClick={() => setActiveTab('devices')}
              className={`px-3 py-2 rounded-lg text-sm font-medium ${activeTab === 'devices' ? 'bg-stone-100 text-stone-900' : 'text-stone-500 hover:text-stone-900'}`}
            >
              Devices
            </button>
            <button 
              onClick={() => setActiveTab('settings')}
              className={`px-3 py-2 rounded-lg text-sm font-medium ${activeTab === 'settings' ? 'bg-stone-100 text-stone-900' : 'text-stone-500 hover:text-stone-900'}`}
            >
              Settings
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
                        sync_enabled: false,
                        sync_schedule: '0 0 * * *',
                        year: new Date().getFullYear(),
                        caldav_account_id: accounts.length > 0 ? accounts[0].id : '',
                        device_id: devices.length > 0 ? devices[0].id : ''
                    });
                    setShowDocForm(true);
                }}
                className="flex items-center px-4 py-2 bg-stone-900 text-white rounded-lg hover:bg-stone-800"
              >
                <Plus size={18} className="mr-2" />
                Add Document
              </button>
            </div>

            {documents.length === 0 ? (
                <div className="text-center py-12 text-stone-500 bg-white rounded-2xl border border-stone-200">
                    No documents found. Create one to get started.
                </div>
            ) : (
                <div className="grid gap-4">
                    {documents.map(doc => (
                        <div key={doc.id} className="bg-white p-6 rounded-2xl border border-stone-200 shadow-sm flex flex-col md:flex-row justify-between gap-4">
                            <div className="flex-1">
                                <div className="flex items-center gap-2 mb-1">
                                    <h3 className="font-bold text-lg">{doc.title}</h3>
                                    {doc.sync_status === 'syncing' && <RefreshCw size={14} className="animate-spin text-blue-500" />}
                                    {doc.sync_status === 'error' && <XCircle size={14} className="text-red-500" />}
                                    {doc.sync_status === 'idle' && doc.last_synced_at && <CheckCircle size={14} className="text-green-500" />}
                                </div>
                                <p className="text-sm text-stone-500 font-mono mb-2">{doc.remote_path}</p>
                                <div className="flex items-center gap-4 text-xs text-stone-500">
                                    <span className="flex items-center gap-1">
                                        <Clock size={12} />
                                        {doc.sync_enabled ? `Scheduled: ${doc.sync_schedule}` : 'Manual Sync Only'}
                                    </span>
                                    {doc.last_synced_at && (
                                        <span>Last synced: {new Date(doc.last_synced_at).toLocaleString()}</span>
                                    )}
                                </div>
                                {doc.last_error && (
                                    <p className="text-xs text-red-600 mt-2 bg-red-50 p-2 rounded">Error: {doc.last_error}</p>
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                                <button 
                                    onClick={() => syncDoc(doc.id)}
                                    disabled={doc.sync_status === 'syncing'}
                                    className="p-2 text-stone-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg disabled:opacity-50"
                                    title="Sync Now"
                                >
                                    <RefreshCw size={20} className={doc.sync_status === 'syncing' ? 'animate-spin' : ''} />
                                </button>
                                <button 
                                    onClick={() => {
                                        setEditingDoc(doc);
                                        setDocForm({
                                            title: doc.title,
                                            remote_path: doc.remote_path,
                                            sync_enabled: !!doc.sync_enabled,
                                            sync_schedule: doc.sync_schedule,
                                            year: doc.year || new Date().getFullYear(),
                                            caldav_account_id: doc.caldav_account_id,
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
                    ))}
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
                    setDeviceForm({ name: '', host: '', username: 'root', password: '', port: 22 });
                    setShowDeviceForm(true);
                }}
                className="flex items-center px-4 py-2 bg-stone-900 text-white rounded-lg hover:bg-stone-800"
              >
                <Plus size={18} className="mr-2" />
                Add Device
              </button>
            </div>

            <div className="grid gap-4">
                {devices.map(dev => (
                    <div key={dev.id} className="bg-white p-6 rounded-2xl border border-stone-200 shadow-sm flex justify-between items-center">
                        <div>
                            <div className="flex items-center gap-2">
                                <Tablet size={18} />
                                <h3 className="font-bold">{dev.name}</h3>
                                {deviceStatus[dev.id] === 'connected' && <Wifi size={14} className="text-green-500" title="Connected" />}
                                {deviceStatus[dev.id] === 'disconnected' && <WifiOff size={14} className="text-red-500" title="Disconnected" />}
                                {deviceStatus[dev.id] === 'checking' && <RefreshCw size={14} className="animate-spin text-stone-400" title="Checking..." />}
                            </div>
                            <p className="text-sm text-stone-500 font-mono mt-1">{dev.username}@{dev.host}:{dev.port}</p>
                            <p className="text-xs text-stone-400 mt-1">Last connected: {new Date(dev.last_connected_at).toLocaleString()}</p>
                        </div>
                        <div className="flex gap-2">
                            <button 
                                onClick={() => {
                                    setEditingDevice(dev);
                                    setDeviceForm({ ...dev, password: '' }); // Don't show password
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
                ))}
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-2xl font-bold">CalDAV Accounts</h2>
              <button 
                onClick={() => {
                    setEditingAccount(null);
                    setAccountForm({ name: '', url: '', username: '', password: '', selected_calendars: [] });
                    setShowAccountForm(true);
                }}
                className="flex items-center px-4 py-2 bg-stone-900 text-white rounded-lg hover:bg-stone-800"
              >
                <Plus size={18} className="mr-2" />
                Add Account
              </button>
            </div>

            <div className="grid gap-4">
                {accounts.map(acc => {
                    const selected = JSON.parse(acc.selected_calendars || '[]');
                    return (
                        <div key={acc.id} className="bg-white p-6 rounded-2xl border border-stone-200 shadow-sm flex justify-between items-center">
                            <div>
                                <h3 className="font-bold">{acc.name}</h3>
                                <p className="text-sm text-stone-500">{acc.url}</p>
                                <p className="text-xs text-stone-400">{acc.username} • {selected.length} calendars selected</p>
                            </div>
                            <div className="flex gap-2">
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
                        <label className="block text-sm font-medium mb-1">CalDAV Account</label>
                        <select 
                            required
                            className="w-full px-3 py-2 border rounded-lg"
                            value={docForm.caldav_account_id}
                            onChange={e => setDocForm({...docForm, caldav_account_id: e.target.value})}
                        >
                            <option value="">Select Account</option>
                            {accounts.map(a => (
                                <option key={a.id} value={a.id}>{a.name}</option>
                            ))}
                        </select>
                    </div>
                    <div className="flex items-center gap-2">
                        <input 
                            type="checkbox" 
                            id="sync_enabled"
                            checked={docForm.sync_enabled}
                            onChange={e => setDocForm({...docForm, sync_enabled: e.target.checked})}
                        />
                        <label htmlFor="sync_enabled" className="text-sm font-medium">Enable Scheduled Sync</label>
                    </div>
                    {docForm.sync_enabled && (
                        <div>
                            <label className="block text-sm font-medium mb-1">Schedule (Cron)</label>
                            <input 
                                type="text" 
                                required
                                className="w-full px-3 py-2 border rounded-lg font-mono"
                                value={docForm.sync_schedule}
                                onChange={e => setDocForm({...docForm, sync_schedule: e.target.value})}
                                placeholder="0 0 * * *"
                            />
                            <p className="text-xs text-stone-500 mt-1">Example: 0 0 * * * (Daily at midnight)</p>
                        </div>
                    )}
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
    </div>
  );
}
