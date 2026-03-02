import React, { useState, useEffect } from 'react';
import { Calendar, Settings, Upload, Plus, Trash2, RefreshCw, FileText, CheckCircle, XCircle, Clock } from 'lucide-react';
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
  caldav_account_id: string;
}

interface Account {
  id: string;
  name: string;
  url: string;
  username: string;
  calendar_id: string;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'library' | 'settings'>('library');
  const [documents, setDocuments] = useState<Document[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Forms state
  const [showDocForm, setShowDocForm] = useState(false);
  const [editingDoc, setEditingDoc] = useState<Document | null>(null);
  const [docForm, setDocForm] = useState({
    title: '',
    remote_path: '/home/root/.local/share/remarkable/xochitl/calendar.pdf',
    sync_enabled: false,
    sync_schedule: '0 0 * * *', // Daily at midnight
    caldav_account_id: ''
  });

  const [showAccountForm, setShowAccountForm] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [accountForm, setAccountForm] = useState({
    name: '',
    url: '',
    username: '',
    password: '',
    calendar_id: ''
  });

  const fetchData = async () => {
    setLoading(true);
    try {
      const [docsRes, accountsRes] = await Promise.all([
        axios.get('/api/library'),
        axios.get('/api/settings')
      ]);
      
      // Defensive check: ensure data is an array
      const docsData = Array.isArray(docsRes.data) ? docsRes.data : (docsRes.data.documents || []);
      const accountsData = Array.isArray(accountsRes.data) ? accountsRes.data : [];
      
      setDocuments(docsData);
      setAccounts(accountsData);
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

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000); // Poll every 10s
    return () => clearInterval(interval);
  }, []);

  const handleDocSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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
      alert(err.response?.data?.error || err.message);
    }
  };

  const handleAccountSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editingAccount) {
        await axios.put(`/api/settings/${editingAccount.id}`, accountForm);
      } else {
        await axios.post('/api/settings', accountForm);
      }
      setShowAccountForm(false);
      setEditingAccount(null);
      setAccountForm({ name: '', url: '', username: '', password: '', calendar_id: '' });
      fetchData();
    } catch (err: any) {
      alert(err.response?.data?.error || err.message);
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
          </div>
          <nav className="flex gap-4">
            <button 
              onClick={() => setActiveTab('library')}
              className={`px-3 py-2 rounded-lg text-sm font-medium ${activeTab === 'library' ? 'bg-stone-100 text-stone-900' : 'text-stone-500 hover:text-stone-900'}`}
            >
              Library
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
                        caldav_account_id: accounts.length > 0 ? accounts[0].id : ''
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
                                            caldav_account_id: doc.caldav_account_id
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

        {activeTab === 'settings' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-2xl font-bold">CalDAV Accounts</h2>
              <button 
                onClick={() => {
                    setEditingAccount(null);
                    setAccountForm({ name: '', url: '', username: '', password: '', calendar_id: '' });
                    setShowAccountForm(true);
                }}
                className="flex items-center px-4 py-2 bg-stone-900 text-white rounded-lg hover:bg-stone-800"
              >
                <Plus size={18} className="mr-2" />
                Add Account
              </button>
            </div>

            <div className="grid gap-4">
                {accounts.map(acc => (
                    <div key={acc.id} className="bg-white p-6 rounded-2xl border border-stone-200 shadow-sm flex justify-between items-center">
                        <div>
                            <h3 className="font-bold">{acc.name}</h3>
                            <p className="text-sm text-stone-500">{acc.url}</p>
                            <p className="text-xs text-stone-400">{acc.username}</p>
                        </div>
                        <div className="flex gap-2">
                            <button 
                                onClick={() => {
                                    setEditingAccount(acc);
                                    setAccountForm({ ...acc, password: '' }); // Don't show password
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
                ))}
            </div>
          </div>
        )}
      </main>

      {/* Document Modal */}
      {showDocForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl p-8 max-w-md w-full shadow-xl">
                <h3 className="text-xl font-bold mb-4">{editingDoc ? 'Edit Document' : 'New Document'}</h3>
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
                            className="px-4 py-2 bg-stone-900 text-white rounded-lg hover:bg-stone-800"
                        >
                            Save
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
                        <input 
                            type="password" 
                            required={!editingAccount}
                            className="w-full px-3 py-2 border rounded-lg"
                            value={accountForm.password}
                            onChange={e => setAccountForm({...accountForm, password: e.target.value})}
                            placeholder={editingAccount ? "(Unchanged)" : ""}
                        />
                    </div>
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
                            className="px-4 py-2 bg-stone-900 text-white rounded-lg hover:bg-stone-800"
                        >
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
