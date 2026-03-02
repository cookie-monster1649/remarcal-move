/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Calendar, Download, Settings, Upload, Check, AlertCircle, Loader2 } from 'lucide-react';
import { format, addDays, startOfWeek, endOfWeek, startOfMonth, endOfMonth, eachDayOfInterval, isSameMonth, isSameDay, parseISO } from 'date-fns';
import jsPDF from 'jspdf';
import axios from 'axios';

// Types
interface CalendarEvent {
  summary: string;
  start: Date;
  end: Date;
  description?: string;
  location?: string;
  allDay?: boolean;
}

interface DeviceFile {
  uuid: string;
  name: string;
  lastModified: string;
}

interface SSHConfig {
  host: string;
  username: string;
  privateKey: string;
  passphrase?: string;
  password?: string;
}

interface AppState {
  step: 'config' | 'preview' | 'generating';
  activeTab: 'general' | 'caldav' | 'device';
  dataSource: 'mock' | 'caldav';
  config: {
    caldavUrl: string;
    username: string;
    password: string; 
    year: number;
  };
  sshConfig: SSHConfig;
  events: CalendarEvent[];
  documents: DeviceFile[];
  selectedDocumentUuid: string;
  syncStatus: 'idle' | 'connecting' | 'listing' | 'syncing' | 'success' | 'error';
  syncMessage: string;
  error: string | null;
}

export default function App() {
  const [state, setState] = useState<AppState>({
    step: 'config',
    activeTab: 'general',
    dataSource: 'mock',
    config: {
      caldavUrl: '',
      username: '',
      password: '',
      year: new Date().getFullYear(),
    },
    sshConfig: {
      host: '10.11.99.1', // Default USB IP
      username: 'root',
      privateKey: '',
      password: '',
    },
    events: [],
    documents: [],
    selectedDocumentUuid: '',
    syncStatus: 'idle',
    syncMessage: '',
    error: null,
  });

  const [loading, setLoading] = useState(false);
  const [showDotGrid, setShowDotGrid] = useState(true);
  const [showHelp, setShowHelp] = useState(false);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    if (name in state.config) {
        setState(prev => ({
            ...prev,
            config: { ...prev.config, [name]: value }
        }));
    } else if (name in state.sshConfig) {
        setState(prev => ({
            ...prev,
            sshConfig: { ...prev.sshConfig, [name]: value }
        }));
    }
  };

  const fetchCalDavEvents = async () => {
    setLoading(true);
    setState(prev => ({ ...prev, error: null }));
    try {
        const startDate = `${state.config.year}-01-01`;
        const endDate = `${state.config.year}-12-31`;

        const response = await axios.post('/api/caldav/fetch', {
            url: state.config.caldavUrl,
            username: state.config.username,
            password: state.config.password,
            startDate,
            endDate
        });
        
        // Convert string dates back to Date objects
        const events = response.data.events.map((e: any) => ({
            ...e,
            start: new Date(e.start),
            end: new Date(e.end)
        }));
        
        setState(prev => ({ ...prev, events, step: 'preview' }));
    } catch (err: any) {
        setState(prev => ({ ...prev, error: err.response?.data?.error || err.message }));
    } finally {
        setLoading(false);
    }
  };

  const fetchDocuments = async () => {
      setState(prev => ({ ...prev, syncStatus: 'listing', syncMessage: 'Connecting to device...' }));
      try {
          const response = await axios.post('/api/device/list', state.sshConfig);
          setState(prev => ({ 
              ...prev, 
              documents: response.data.documents,
              syncStatus: 'idle',
              syncMessage: ''
          }));
      } catch (err: any) {
          setState(prev => ({ 
              ...prev, 
              syncStatus: 'error', 
              syncMessage: err.response?.data?.error || err.message 
          }));
      }
  };

  const syncDocument = async (pdfBlob: Blob, pageCount: number) => {
      if (!state.selectedDocumentUuid) {
          setState(prev => ({ ...prev, syncStatus: 'error', syncMessage: 'No document selected' }));
          return;
      }

      setState(prev => ({ ...prev, syncStatus: 'syncing', syncMessage: 'Starting sync...' }));
      
      const formData = new FormData();
      formData.append('pdf', pdfBlob, 'calendar.pdf');
      formData.append('host', state.sshConfig.host);
      formData.append('username', state.sshConfig.username);
      formData.append('privateKey', state.sshConfig.privateKey);
      if (state.sshConfig.password) formData.append('password', state.sshConfig.password);
      if (state.sshConfig.passphrase) formData.append('passphrase', state.sshConfig.passphrase);
      formData.append('uuid', state.selectedDocumentUuid);
      formData.append('pageCount', pageCount.toString());
      
      try {
          await axios.post('/api/device/sync', formData, {
              headers: { 'Content-Type': 'multipart/form-data' }
          });
          
          setState(prev => ({ ...prev, syncStatus: 'success', syncMessage: 'Sync complete!' }));
      } catch (err: any) {
          setState(prev => ({ 
              ...prev, 
              syncStatus: 'error', 
              syncMessage: err.response?.data?.error || err.message 
          }));
      }
  };

  const loadMockData = () => {
    const start = new Date(state.config.year, 0, 1);
    const end = new Date(state.config.year, 11, 31);
    const days = eachDayOfInterval({ start, end });
    const mockEvents: CalendarEvent[] = [];

    const eventTitles = ['Meeting with Team', 'Project Sync', 'Lunch', 'Deep Work', 'Client Call', 'Gym', 'Coffee Chat', 'Code Review', 'Design Sprint', 'Strategy Session'];
    const locations = ['Room 101', 'Zoom', 'The Coffee Shop', 'Main Office', 'Conference Room A', 'https://meet.google.com/abc-defg-hij'];

    days.forEach(day => {
      // 1. All Day Events (Single Day) - 10% chance
      if (Math.random() > 0.9) {
        mockEvents.push({
            summary: ['Holiday', 'Team Offsite', 'Conference', 'Birthday'][Math.floor(Math.random() * 4)],
            start: new Date(day.setHours(0, 0, 0, 0)),
            end: new Date(day.setHours(23, 59, 59, 999)),
            location: 'Everywhere'
        });
      }

      // 2. Multi-day All Day Event - 2% chance (start here)
      if (Math.random() > 0.98) {
          const mStart = new Date(day.setHours(0,0,0,0));
          const mEnd = addDays(mStart, 2);
          mEnd.setHours(23,59,59,999);
          mockEvents.push({
              summary: 'Multi-day Workshop',
              start: mStart,
              end: mEnd,
              location: 'Headquarters'
          });
      }

      // 3. Regular Events
      if (Math.random() > 0.3) {
        const numEvents = Math.floor(Math.random() * 4) + 1;
        for (let i = 0; i < numEvents; i++) {
          const hour = 8 + Math.floor(Math.random() * 10); // 8am to 6pm
          const durationMinutes = [30, 60, 90, 120][Math.floor(Math.random() * 4)];
          
          const eventStart = new Date(day);
          eventStart.setHours(hour, Math.random() > 0.5 ? 0 : 30); // Start on hour or half hour
          
          const eventEnd = new Date(eventStart.getTime() + durationMinutes * 60000);
          
          mockEvents.push({
            summary: eventTitles[Math.floor(Math.random() * eventTitles.length)],
            start: eventStart,
            end: eventEnd,
            location: Math.random() > 0.5 ? locations[Math.floor(Math.random() * locations.length)] : undefined
          });
        }
      }
    });

    setState(prev => ({
      ...prev,
      events: mockEvents,
      step: 'preview'
    }));
  };

  const parseICalData = (icalData: string): CalendarEvent | null => {
    try {
      // Improved regex to handle more iCal formats (including those with params)
      const summaryMatch = icalData.match(/SUMMARY(?:;.*)?:(.*)/);
      const startMatch = icalData.match(/DTSTART(?:;.*)?:(\d{8}T\d{6}Z?|\d{8})/);
      const endMatch = icalData.match(/DTEND(?:;.*)?:(\d{8}T\d{6}Z?|\d{8})/);

      if (summaryMatch && startMatch) {
        const parseDate = (str: string) => {
          // Basic ISO parsing
          if (str.length === 8) {
            // YYYYMMDD -> YYYY-MM-DD
            return parseISO(`${str.substring(0, 4)}-${str.substring(4, 6)}-${str.substring(6, 8)}`);
          }
          
          // YYYYMMDDTHHMMSS(Z)
          const cleanStr = str.replace('Z', '');
          const isoStr = `${cleanStr.substring(0, 4)}-${cleanStr.substring(4, 6)}-${cleanStr.substring(6, 8)}T${cleanStr.substring(9, 11)}:${cleanStr.substring(11, 13)}:${cleanStr.substring(13, 15)}`;
          return parseISO(isoStr);
        };

        return {
          summary: summaryMatch[1].trim(),
          start: parseDate(startMatch[1]),
          end: endMatch ? parseDate(endMatch[1]) : parseDate(startMatch[1]), // Default to start if no end
        };
      }
      return null;
    } catch (e) {
      console.warn('Failed to parse event', e);
      return null;
    }
  };

  const fetchCalendar = async () => {
    setLoading(true);
    setState(prev => ({ ...prev, error: null }));

    try {
      const startDate = `${state.config.year}-01-01`;
      const endDate = `${state.config.year}-12-31`;

      const response = await axios.post('/api/caldav/fetch', {
        url: state.config.caldavUrl,
        username: state.config.username,
        password: state.config.password,
        startDate,
        endDate,
      });

      const rawEvents = response.data.events || [];
      const parsedEvents = rawEvents
        .map((e: string) => parseICalData(e))
        .filter((e: CalendarEvent | null): e is CalendarEvent => e !== null);

      setState(prev => ({
        ...prev,
        events: parsedEvents,
        step: 'preview'
      }));
    } catch (err: any) {
      setState(prev => ({
        ...prev,
        error: err.response?.data?.error || err.message || 'Failed to fetch calendar'
      }));
    } finally {
      setLoading(false);
    }
  };

  const generatePDF = () => {
    // 1. Setup Dimensions & Constants
    const DPI = 226;
    const pxToMm = (px: number) => (px / DPI) * 25.4;
    const pageWidth = pxToMm(954);  // ~107.2 mm
    const pageHeight = pxToMm(1695); // ~190.5 mm
    
    // Helper to truncate text
    const truncate = (str: string, maxLength: number) => {
      return str.length > maxLength ? str.substring(0, maxLength) + '...' : str;
    };

    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: [pageWidth, pageHeight],
    });

    // 2. Pre-calculation / Page Mapping
    const start = new Date(state.config.year, 0, 1);
    const end = new Date(state.config.year, 11, 31);
    
    // Ensure we cover full weeks starting on Monday
    const effectiveStart = startOfWeek(startOfMonth(start), { weekStartsOn: 1 });
    const effectiveEnd = endOfWeek(endOfMonth(end), { weekStartsOn: 1 });
    
    const allDays = eachDayOfInterval({ start: effectiveStart, end: effectiveEnd });
    
    const pageMap = {
      year: 1,
      months: {} as Record<string, number>,
      weeks: {} as Record<string, number>,
      days: {} as Record<string, number>,
    };

    let currentPage = 1; // Year view is page 1
    
    let currentMonthKey = '';
    let currentWeekKey = '';
    
    allDays.forEach((day) => {
      const monthKey = format(day, 'yyyy-MM');
      const weekKey = format(day, 'yyyy-ww', { weekStartsOn: 1 });
      
      // New Month?
      // Only add month page if this day is actually in the month (since we expanded to full weeks, we might have prev/next month days)
      if (monthKey !== currentMonthKey && day.getDate() === 1) {
        currentPage++;
        pageMap.months[monthKey] = currentPage;
        currentMonthKey = monthKey;
      }
      
      // New Week?
      if (weekKey !== currentWeekKey) {
        // Check if we already assigned a page to this week (could happen if we cross months)
        if (!pageMap.weeks[weekKey]) {
            currentPage++;
            pageMap.weeks[weekKey] = currentPage;
            currentWeekKey = weekKey;
        }
      }
      
      // Daily View
      currentPage++;
      pageMap.days[format(day, 'yyyy-MM-dd')] = currentPage;
    });

    // 3. Helper Functions for Rendering
    
    const drawNavBar = (currentDate: Date, showWeek: boolean = true) => {
        // Draw Nav Bar: [Year] | Jan Feb ... Dec | [Week X]
        // Wrapped in rounded rect
        const navY = 15;
        const navH = 7;
        const navW = pageWidth - 10;
        const navX = 5;
        
        // Container
        doc.setDrawColor(0);
        doc.setLineWidth(0.3);
        doc.roundedRect(navX, navY, navW, navH, 2, 2, 'S');
        
        doc.setFontSize(7); 
        doc.setFont("helvetica", "normal");
        doc.setTextColor(0);
        
        let cursorX = navX + 2; // Reduced left padding
        const centerY = navY + 4.5;
        
        // Year Link
        const yearStr = format(currentDate, 'yyyy');
        doc.text(yearStr, cursorX, centerY);
        doc.link(cursorX, navY, 8, navH, { pageNumber: pageMap.year });
        cursorX += 7; 
        
        doc.text("|", cursorX, centerY);
        cursorX += 2; 
        
        // Months
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        
        // Calculate available width for months to space them evenly
        // We need to accurately reserve space for Year and Week sections to avoid overlap.
        // Year Section: navX to current cursorX (approx 11mm)
        // Week Section: weekWidth (10) + padding (2) + separator (2) approx 14mm
        
        const yearSectionW = 11; 
        const weekSectionW = showWeek ? 14 : 0; 
        const padding = 0; 
        const availableW = navW - yearSectionW - weekSectionW - padding;
        const monthSlotW = availableW / 12;
        
        months.forEach((m, i) => {
            const mDate = new Date(currentDate.getFullYear(), i, 1);
            const mKey = format(mDate, 'yyyy-MM');
            const targetPage = pageMap.months[mKey];
            
            // Center text in slot
            const slotX = cursorX + (i * monthSlotW);
            const textW = doc.getTextWidth(m);
            const textX = slotX + (monthSlotW - textW) / 2;
            
            // Highlight current
            if (i === currentDate.getMonth()) {
                doc.setFillColor(50, 50, 50);
                // Draw rounded rect centered on text
                doc.roundedRect(textX - 1, navY + 1.5, textW + 2, 4, 1, 1, 'F');
                doc.setTextColor(255);
            } else {
                doc.setTextColor(0);
            }
            
            doc.text(m, textX, centerY);
            
            if (targetPage) {
                doc.link(slotX, navY + 1, monthSlotW, 4, { pageNumber: targetPage });
            }
            
            // Separator (visual only)
            if (i < 11) {
                doc.setTextColor(200);
                doc.text("|", slotX + monthSlotW, centerY);
                doc.setTextColor(0);
            }
        });
        
        // Week Link
        if (showWeek) {
            const weekStr = `Wk ${format(currentDate, 'ww', { weekStartsOn: 1 })}`;
            const wKey = format(currentDate, 'yyyy-ww', { weekStartsOn: 1 });
            const wPage = pageMap.weeks[wKey];
            
            // Right align the week
            const weekWidth = 10;
            const weekX = navX + navW - weekWidth - 2;
            
            // Draw separator before week
            doc.setTextColor(0); // Ensure separator is black
            doc.text("|", weekX - 2, centerY);
            
            if (wPage) {
                doc.setDrawColor(0);
                doc.roundedRect(weekX, navY + 1.5, weekWidth, 4, 1, 1, 'S');
                doc.setTextColor(0);
                doc.text(weekStr, weekX + 1, centerY);
                doc.link(weekX, navY + 1, weekWidth, 4, { pageNumber: wPage });
            }
        }
    };

    // 4. Render Pages
    
    // --- Page 1: Year View ---
    doc.setFontSize(14);
    doc.setFont("helvetica", "normal");
    doc.text(`${state.config.year} Calendar`, pageWidth / 2, 10, { align: 'center' });
    
    // 12 Months Grid (3x4)
    const yMargin = 15;
    const yColWidth = (pageWidth - 20) / 3;
    const yRowHeight = (pageHeight - 30) / 4;
    
    for (let i = 0; i < 12; i++) {
        const mDate = new Date(state.config.year, i, 1);
        const col = i % 3;
        const row = Math.floor(i / 3);
        const x = 10 + (col * yColWidth);
        const y = yMargin + (row * yRowHeight);
        
        // Month Title
        doc.setFontSize(10);
        doc.setFont("helvetica", "normal");
        doc.text(format(mDate, 'MMMM'), x + yColWidth/2, y + 5, { align: 'center' });
        
        // Link Month Title
        const mKey = format(mDate, 'yyyy-MM');
        if (pageMap.months[mKey]) {
            // Make the clickable area larger and centered
            const textWidth = doc.getTextWidth(format(mDate, 'MMMM'));
            doc.link(x + yColWidth/2 - textWidth/2 - 2, y, textWidth + 4, 6, { pageNumber: pageMap.months[mKey] });
        }
        
        // Mini Calendar
        doc.setFontSize(6);
        doc.setFont("helvetica", "normal");
        const daysInMonth = eachDayOfInterval({ start: startOfMonth(mDate), end: endOfMonth(mDate) });
        // Monday start adjustment
        let startDay = startOfMonth(mDate).getDay(); // 0 = Sun
        startDay = startDay === 0 ? 6 : startDay - 1; // 0 = Mon, 6 = Sun
        
        const cellW = (yColWidth - 4) / 7;
        const cellH = 3;
        
        // Header (Mon start)
        ['M','T','W','T','F','S','S'].forEach((d, idx) => {
            doc.text(d, x + 2 + (idx * cellW) + cellW/2, y + 9, { align: 'center' });
        });
        
        daysInMonth.forEach((d) => {
            const date = d.getDate();
            const offset = startDay;
            const gridIdx = date + offset - 1;
            const r = Math.floor(gridIdx / 7);
            const c = gridIdx % 7;
            
            const dX = x + 2 + (c * cellW);
            const dY = y + 13 + (r * cellH);
            
            // Highlight if event exists
            const hasEvent = state.events.some(e => isSameDay(e.start, d));
            if (hasEvent) {
                doc.setFont("helvetica", "bold");
                doc.setFillColor(220, 220, 220);
                doc.circle(dX + cellW/2, dY - 1, 1.5, 'F');
            } else {
                doc.setFont("helvetica", "normal");
            }
            
            doc.text(date.toString(), dX + cellW/2, dY, { align: 'center' });
            
            // Link to Daily Page
            const dKey = format(d, 'yyyy-MM-dd');
            if (pageMap.days[dKey]) {
                doc.link(dX, dY - 2, cellW, cellH, { pageNumber: pageMap.days[dKey] });
            }
        });
    }

    // --- Chronological Pages ---
    
    currentMonthKey = '';
    currentWeekKey = '';
    
    // Track rendered weeks to avoid duplicates
    const renderedWeeks = new Set<string>();

    allDays.forEach((day) => {
        const monthKey = format(day, 'yyyy-MM');
        const weekKey = format(day, 'yyyy-ww', { weekStartsOn: 1 });
        
        // --- Month View ---
        if (monthKey !== currentMonthKey && day.getDate() === 1) {
            doc.addPage();
            currentMonthKey = monthKey;
            
            // Header
            doc.setFontSize(14);
            doc.setFont("helvetica", "normal");
            doc.text(format(day, 'MMMM yyyy'), pageWidth / 2, 10, { align: 'center' });
            
            // Nav Bar (No Week)
            drawNavBar(day, false);
            
            // Month Grid
            const mStart = startOfMonth(day);
            const mEnd = endOfMonth(day);
            // Ensure grid covers full weeks for visual consistency
            const gridStart = startOfWeek(mStart, { weekStartsOn: 1 });
            const gridEnd = endOfWeek(mEnd, { weekStartsOn: 1 });
            
            const mDays = eachDayOfInterval({ start: gridStart, end: gridEnd });
            
            const gridX = 8; // Reduced from 12 to sit closer to week numbers
            const gridY = 25; 
            const gridW = pageWidth - 13; // Increased width (pageWidth - 5 - 8)
            const gridH = pageHeight - 35;
            const cellW = gridW / 7;
            const cellH = gridH / 6; 
            
            // Grid Lines
            doc.setDrawColor(0);
            doc.setLineWidth(0.1);
            for(let i=0; i<=7; i++) doc.line(gridX + i*cellW, gridY, gridX + i*cellW, gridY + 6*cellH);
            for(let i=0; i<=6; i++) doc.line(gridX, gridY + i*cellH, gridX + gridW, gridY + i*cellH);
            
            // Week Numbers (Left Side)
            doc.setFontSize(7); // Increased from 6
            doc.setFont("helvetica", "bold"); // Bold
            doc.setTextColor(150);
            for(let i=0; i<6; i++) {
                const wDate = addDays(gridStart, i*7);
                // Only show if week is relevant to this month or previous/next
                if (i * 7 < mDays.length) {
                    const wNum = format(wDate, 'ww', { weekStartsOn: 1 });
                    const wKey = format(wDate, 'yyyy-ww', { weekStartsOn: 1 });
                    const yPos = gridY + i*cellH + cellH/2;
                    
                    doc.text(`W${wNum}`, 1, yPos); // Moved slightly left
                    
                    // Link to Week
                    if (pageMap.weeks[wKey]) {
                        doc.link(0, gridY + i*cellH, 8, cellH, { pageNumber: pageMap.weeks[wKey] });
                    }
                }
            }

            // Days
            mDays.forEach((d, idx) => {
                const r = Math.floor(idx / 7);
                const c = idx % 7;
                
                // Stop if we exceed 6 rows
                if (r > 5) return;

                const x = gridX + c*cellW;
                const y = gridY + r*cellH;
                
                // Dim days not in current month
                const isCurrentMonth = isSameMonth(d, day);
                doc.setTextColor(isCurrentMonth ? 0 : 150);
                
                // Day Name (Top Left)
                doc.setFontSize(7);
                doc.setFont("helvetica", "bold");
                const dayName = format(d, 'EEE');
                doc.text(dayName, x + 2, y + 4);

                // Date Number (Top Right, Grey)
                doc.setFontSize(9);
                doc.setFont("helvetica", "normal");
                doc.setTextColor(150);
                doc.text(d.getDate().toString(), x + cellW - 2, y + 4, { align: 'right' });
                
                // Link
                const dKey = format(d, 'yyyy-MM-dd');
                if (pageMap.days[dKey]) {
                    doc.link(x, y, cellW, cellH, { pageNumber: pageMap.days[dKey] });
                }
                
                // Events (Pills)
                const dayEvents = state.events.filter(e => isSameDay(e.start, d));
                let eventY = y + 8;
                doc.setFontSize(5);
                doc.setTextColor(0); // Reset text color for events
                dayEvents.slice(0, 4).forEach(e => {
                    const summary = truncate(e.summary, 12);
                    doc.roundedRect(x + 1, eventY, cellW - 2, 3, 1, 1, 'S');
                    doc.text(summary, x + 2, eventY + 2);
                    eventY += 4;
                });
            });
        }
        
        // --- Week View ---
        if (!renderedWeeks.has(weekKey)) {
             renderedWeeks.add(weekKey);
             doc.addPage();
             
             const wStart = startOfWeek(day, { weekStartsOn: 1 });
             const wEnd = endOfWeek(day, { weekStartsOn: 1 });
             
             // Header
             doc.setFontSize(12);
             doc.setFont("helvetica", "normal");
             doc.text(`Week ${format(day, 'ww', { weekStartsOn: 1 })} | ${format(wStart, 'MMM d')} - ${format(wEnd, 'MMM d')}`, pageWidth/2, 10, { align: 'center' });
             
             drawNavBar(day);
             
             // Grid Layout:
             // Mon, Tue, Wed
             // Thu, Fri, Notes
             // Sat, Sun, Notes
             
             const gridX = 5;
             const gridY = 25;
             const gridW = pageWidth - 10;
             const gridH = pageHeight - 35;
             const cellW = gridW / 3;
             const cellH = gridH / 3;
             
             const weekDays = eachDayOfInterval({ start: wStart, end: wEnd });
             
             // Map days to grid positions (0-6 Mon-Sun)
             const gridMap = [
                 {c:0, r:0}, // Mon
                 {c:1, r:0}, // Tue
                 {c:2, r:0}, // Wed
                 {c:0, r:1}, // Thu
                 {c:1, r:1}, // Fri
                 {c:0, r:2}, // Sat
                 {c:1, r:2}, // Sun
             ];
             
             weekDays.forEach((d, i) => {
                 const pos = gridMap[i];
                 const x = gridX + pos.c*cellW;
                 const y = gridY + pos.r*cellH;
                 
                 // Cell Border
                 doc.setDrawColor(0);
                 doc.setLineWidth(0.1);
                 doc.rect(x, y, cellW, cellH);
                 
                 // Header: Day Abbr (Black, Top Right) + Date (Grey, Top Right)
                 
                 doc.setFontSize(10);
                 doc.setFont("helvetica", "bold");
                 doc.setTextColor(0);
                 const dayName = format(d, 'EEE');
                 doc.text(dayName, x + cellW - 12, y + 6, { align: 'right' });
                 
                 doc.setFont("helvetica", "normal");
                 doc.setTextColor(150);
                 const dateNum = format(d, 'd');
                 doc.text(dateNum, x + cellW - 4, y + 6, { align: 'right' });
                 
                 // Link to Day
                 const dKey = format(d, 'yyyy-MM-dd');
                 if (pageMap.days[dKey]) {
                     doc.link(x, y, cellW, 8, { pageNumber: pageMap.days[dKey] });
                 }
                 
                 // Events
                 const dayEvents = state.events.filter(e => isSameDay(e.start, d));
                 let eventY = y + 12;
                 doc.setFontSize(6);
                 doc.setFont("helvetica", "normal");
                 doc.setTextColor(0);
                 dayEvents.forEach(e => {
                     if (eventY < y + cellH - 5) {
                         const time = format(e.start, 'HH:mm');
                         const summary = truncate(e.summary, 20);
                         doc.roundedRect(x + 2, eventY, cellW - 4, 5, 1, 1, 'S');
                         doc.text(`${time} ${summary}`, x + 3, eventY + 3.5);
                         eventY += 6;
                     }
                 });
             });
             
             // Notes Section (Occupies Col 3 of Row 2 & 3)
             // Grid coords: (2,1) and (2,2)
             // We draw one big rectangle
             const notesX = gridX + 2*cellW;
             const notesY = gridY + 1*cellH;
             const notesW = cellW;
             const notesH = 2*cellH;
             
             doc.rect(notesX, notesY, notesW, notesH);
             doc.setFontSize(10);
             doc.setTextColor(0);
             doc.text("Notes", notesX + 5, notesY + 6);
        }
        
        // --- Daily View ---
        doc.addPage();
        
        // Header
        doc.setFontSize(14);
        doc.setFont("helvetica", "normal");
        doc.text(format(day, 'EEEE, MMMM d, yyyy'), pageWidth/2, 10, { align: 'center' });
        
        drawNavBar(day);
        
        // Layout: 
        // All Day Events (Top)
        // Schedule (Left) | Tasks (Right Top) | Notes (Right Bottom)
        
        const contentY = 25; 
        const allDayH = 10; 
        const mainContentY = contentY + allDayH + 8;
        const mainContentH = pageHeight - mainContentY - 10;
        
        // 3/5 Schedule, 2/5 Tasks/Notes
        const leftColW = (pageWidth - 15) * 0.6; // -15 for margins (5 left, 5 mid, 5 right)
        const rightColX = 5 + leftColW + 5;
        const rightColW = pageWidth - rightColX - 5;
        
        // All Day Section
        doc.setDrawColor(200); // Grey outline
        doc.setLineWidth(0.2);
        doc.roundedRect(5, contentY, pageWidth - 10, allDayH, 2, 2, 'S');
        doc.setFontSize(8);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(150); // Grey text
        doc.text("All day", 7, contentY + 6); 
        
        // Render All Day Events (Pills)
        const allDayEvents = state.events.filter(e => {
            const duration = e.end.getTime() - e.start.getTime();
            const isMidnight = e.start.getHours() === 0 && e.start.getMinutes() === 0;
            return isSameDay(e.start, day) && (duration >= 86400000 || isMidnight);
        });
        
        let adX = 35; 
        allDayEvents.forEach(e => {
            doc.setFontSize(7);
            const summary = truncate(e.summary, 30);
            const textW = doc.getTextWidth(summary) + 4;
            
            // Pill
            doc.setFillColor(245, 245, 245);
            doc.setDrawColor(100);
            doc.setLineWidth(0.1);
            doc.roundedRect(adX, contentY + 2, textW, 6, 1, 1, 'FD');
            
            doc.setTextColor(0);
            doc.text(summary, adX + 2, contentY + 6);
            adX += textW + 2; 
        });
        
        // Schedule Header
        doc.setTextColor(0); // Reset to black
        doc.setFontSize(11);
        doc.text("Schedule", 5, mainContentY - 3);
        doc.setLineWidth(0.3);
        doc.setDrawColor(0); // Black line
        doc.line(5, mainContentY, 5 + leftColW, mainContentY);
        
        // Schedule Grid
        const startHour = 5;
        const endHour = 24; 
        const totalHours = endHour - startHour;
        const hourH = mainContentH / totalHours;
        
        // Draw Grid Lines & Times
        for (let h = startHour; h <= endHour; h++) {
            const y = mainContentY + (h - startHour) * hourH;
            doc.setLineWidth(0.1);
            doc.setDrawColor(200); 
            doc.line(5, y, 5 + leftColW, y);
            
            if (h < endHour) {
                doc.setFontSize(7);
                doc.setTextColor(100);
                const timeLabel = format(new Date().setHours(h, 0), 'h a');
                doc.text(timeLabel, 5, y + 3);
            }
        }
        
        // Draw Events (Overlapping Logic)
        const dayEvents = state.events.filter(e => {
            const duration = e.end.getTime() - e.start.getTime();
            const isMidnight = e.start.getHours() === 0 && e.start.getMinutes() === 0;
            if (duration >= 86400000 || isMidnight) return false;
            return isSameDay(e.start, day);
        });
        
        // 1. Normalize and Sort
        const items = dayEvents.map(e => {
            let startH = e.start.getHours() + e.start.getMinutes() / 60;
            let endH = e.end.getHours() + e.end.getMinutes() / 60;
            if (endH < startH) endH += 24;
            
            // Clip
            if (startH < startHour) startH = startHour;
            if (endH > endHour) endH = endHour;
            
            return {
                event: e,
                start: startH,
                end: endH,
                duration: endH - startH,
                colIndex: 0,
                totalCols: 1
            };
        }).filter(i => i.end > i.start)
          .sort((a, b) => a.start - b.start || b.duration - a.duration);
        
        // 2. Cluster overlapping events
        const clusters: typeof items[] = [];
        let currentCluster: typeof items = [];
        let clusterEnd = -1;
        
        items.forEach(item => {
            if (currentCluster.length === 0) {
                currentCluster.push(item);
                clusterEnd = item.end;
            } else {
                if (item.start < clusterEnd) {
                    currentCluster.push(item);
                    if (item.end > clusterEnd) clusterEnd = item.end;
                } else {
                    clusters.push(currentCluster);
                    currentCluster = [item];
                    clusterEnd = item.end;
                }
            }
        });
        if (currentCluster.length > 0) clusters.push(currentCluster);
        
        const locationsForNotes: { summary: string, location: string }[] = [];

        // Helper for Pin Icon
        const drawPinIcon = (x: number, y: number, size: number) => {
            doc.setFillColor(100, 100, 100); // Grey
            const r = size / 2.5; // Radius of head
            const cy = y + r;
            const cx = x + size / 2;
            
            // Triangle (Tail)
            doc.triangle(cx - r*0.8, cy + r*0.2, cx + r*0.8, cy + r*0.2, cx, y + size, 'F');
            
            // Head (Circle)
            doc.circle(cx, cy, r, 'F');
            
            // Hole (White Circle)
            doc.setFillColor(255, 255, 255);
            doc.circle(cx, cy, r * 0.4, 'F');
        };

        // 3. Render Clusters
        clusters.forEach(cluster => {
            // Assign columns
            const columns: typeof items[] = [];
            cluster.forEach(item => {
                let placed = false;
                for(let i=0; i<columns.length; i++) {
                    const lastInCol = columns[i][columns[i].length - 1];
                    if (item.start >= lastInCol.end) {
                        columns[i].push(item);
                        item.colIndex = i;
                        placed = true;
                        break;
                    }
                }
                if (!placed) {
                    columns.push([item]);
                    item.colIndex = columns.length - 1;
                }
            });
            
            // Render items in cluster
            const totalCols = columns.length;
            const scheduleW = leftColW - 15; // 15 is left margin (5 + 10 for time)
            const colW = scheduleW / totalCols;
            const scheduleRightEdge = 5 + leftColW;
            
            cluster.forEach(item => {
                const y = mainContentY + (item.start - startHour) * hourH;
                const h = (item.end - item.start) * hourH;
                const x = 15 + (item.colIndex * colW);
                
                // Extend width to the right edge of the schedule column
                const rectW = scheduleRightEdge - x;
                
                // Draw Event Box
                doc.setFillColor(245, 245, 245);
                doc.setDrawColor(100);
                doc.setLineWidth(0.1);
                doc.roundedRect(x, y, rectW, h, 1, 1, 'FD');
                
                // Determine Visible Width for Content
                // If this is not the last column, the next column's event will cover the right side.
                // UNLESS the next column's event starts significantly later (e.g. > 30 mins later).
                // But for simplicity and robustness based on user request:
                // "Where overlapping events names have space to go the whole way across since the event over the top is far down enough that the full title can show, show the event name full width."
                
                // We need to check if there is an event in the NEXT column that actually overlaps vertically with the TOP part of this event.
                // If the next column's event starts later than this event's start + text height, we can use full width.
                
                let visibleW = rectW; // Default to full width
                
                if (item.colIndex < totalCols - 1) {
                    // Check next column(s) for immediate vertical overlap
                    // Find the earliest start time of an event in a higher column index that overlaps with this event's duration
                    let nextColStart = item.end; // Default to end of this event
                    
                    // Look at all items in the cluster that are in higher columns
                    const overlappingItems = cluster.filter(ci => 
                        ci.colIndex > item.colIndex && 
                        ci.start < item.end && 
                        ci.end > item.start
                    );
                    
                    if (overlappingItems.length > 0) {
                        // Find the one that starts earliest
                        const earliestOverlap = Math.min(...overlappingItems.map(ci => ci.start));
                        
                        // If the overlap starts very close to the top of this event (e.g. within 15 mins / 0.25h), constrain width
                        if (earliestOverlap < item.start + 0.5) { // 30 mins buffer for title visibility
                             visibleW = colW;
                        }
                    }
                }

                // Text
                doc.setTextColor(0);
                
                // For short events (15m = 0.25h), allow smaller text or overflow
                const isShortEvent = h < 4;
                const fontSize = isShortEvent ? 6 : 8;
                doc.setFontSize(fontSize);
                doc.setFont("helvetica", "normal");
                
                const hasLocation = !!item.event.location;
                
                // Consistent small icon size
                const iconSize = 2; 
                const iconPadding = 1;
                
                // Calculate available width for text
                // visibleW - 2 (left pad) - 2 (right pad) - (icon + pad if present)
                const availableWidth = visibleW - 4 - (hasLocation ? iconSize + iconPadding : 0);
                
                let textLines: string[] = [];
                const summary = item.event.summary;
                
                // Text Wrapping Logic
                // Calculate max lines that fit vertically
                // Line height approx 3.5mm for font size 8, 2.5mm for size 6
                const lineHeight = isShortEvent ? 2.5 : 3.5;
                const maxLines = Math.floor((h - 1) / lineHeight); // -1 for padding
                
                // For very short events (e.g. 15 mins), maxLines might be 0 or 1.
                // User said: "enable Text truncation for short events, text should not overflow outside the pill."
                
                if (maxLines <= 1 || isShortEvent) {
                    // Single line truncation
                    let text = summary;
                    
                    // Always truncate to fit available width
                    if (doc.getTextWidth(text) > availableWidth) {
                        while (doc.getTextWidth(text + '...') > availableWidth && text.length > 0) {
                            text = text.slice(0, -1);
                        }
                        text += '...';
                    }
                    textLines = [text];
                } else {
                    // Multi-line wrapping
                    const lines = doc.splitTextToSize(summary, availableWidth);
                    if (lines.length > maxLines) {
                        // Truncate the last allowed line
                        const visibleLines = lines.slice(0, maxLines);
                        let lastLine = visibleLines[maxLines - 1];
                        while (doc.getTextWidth(lastLine + '...') > availableWidth && lastLine.length > 0) {
                            lastLine = lastLine.slice(0, -1);
                        }
                        visibleLines[maxLines - 1] = lastLine + '...';
                        textLines = visibleLines;
                    } else {
                        textLines = lines;
                    }
                }
                
                // Render Text
                let textY = y + 3; // Default top aligned
                
                if (isShortEvent) {
                     // Center vertically for short events
                     const textHeight = fontSize * 0.3527; // font size to mm
                     textY = y + h/2 + textHeight/2 - 0.5;
                }
                
                doc.text(textLines, x + 2, textY);

                // Location Icon (if location exists)
                if (hasLocation) {
                    locationsForNotes.push({ summary: item.event.summary, location: item.event.location! });
                    
                    // Draw Pin Icon
                    // Right aligned within VISIBLE width: x + visibleW - 2 (pad) - iconSize
                    const iconX = x + visibleW - 2 - iconSize;
                    
                    let iconY = y + 1.5; // Top aligned with padding
                    if (isShortEvent) {
                        // Center vertically for short events
                        iconY = y + (h - iconSize) / 2;
                    }
                    
                    drawPinIcon(iconX, iconY, iconSize);
                }
            });
        });
        
        // Tasks Header
        doc.setTextColor(0);
        doc.setFontSize(11);
        doc.text("Tasks", rightColX, mainContentY - 3);
        doc.setLineWidth(0.3);
        doc.setDrawColor(0);
        doc.line(rightColX, mainContentY, rightColX + rightColW, mainContentY);
        
        // Tasks List (5 items)
        const taskCount = 5;
        const taskItemH = 8; // mm per item
        const taskSectionH = taskCount * taskItemH;
        
        for(let i=0; i<taskCount; i++) {
            const y = mainContentY + (i * taskItemH) + 6;
            
            // Circle (Not bold)
            doc.setLineWidth(0.1);
            doc.setDrawColor(0); // Black circle
            doc.circle(rightColX + 3, y - 1.5, 1.5);
            
            // Line (Grey)
            doc.setDrawColor(200);
            doc.line(rightColX + 8, y, rightColX + rightColW, y);
        }
        
        // Notes Header
        const notesY = mainContentY + taskSectionH + 10;
        doc.setTextColor(0);
        doc.setFontSize(11);
        doc.text("Notes", rightColX, notesY - 3);
        doc.setLineWidth(0.3);
        doc.setDrawColor(0);
        doc.line(rightColX, notesY, rightColX + rightColW, notesY);
        
        // Notes Lines
        const notesBottom = mainContentY + mainContentH;
        const notesH = notesBottom - notesY;
        const lineGap = 8;
        const lineCount = Math.floor(notesH / lineGap);
        
        for(let i=0; i<lineCount; i++) {
            const y = notesY + ((i+1) * lineGap);
            doc.setLineWidth(0.1);
            doc.setDrawColor(200); // Grey lines
            doc.line(rightColX, y, rightColX + rightColW, y);
        }
        
        // Render Locations in Notes (Bottom Up)
        if (locationsForNotes.length > 0) {
            doc.setFontSize(7);
            doc.setTextColor(80); // Dark grey
            
            // Deduplicate
            const uniqueLocs = Array.from(new Set(locationsForNotes.map(l => `${l.summary}: ${l.location}`)));
            
            // Calculate space needed
            const maxW = rightColW; // Use full width
            let currentY = notesBottom - 2;
            
            // Render from bottom up
            [...uniqueLocs].reverse().forEach(locStr => {
                // Truncate massively if needed (cap at 200 chars to be safe)
                const safeStr = locStr.length > 200 ? locStr.substring(0, 200) + '...' : locStr;
                
                const lines = doc.splitTextToSize(safeStr, maxW);
                const blockH = lines.length * 3; // 3mm line height
                
                if (currentY - blockH > notesY + 8) { // Ensure we don't overwrite header + space for icon
                    doc.text(lines, rightColX, currentY - blockH + 2.5); // +2.5 for baseline adjustment
                    currentY -= (blockH + 1); // +1mm spacing between items
                }
            });
            
            // Draw Icon above the list
            if (currentY > notesY + 5) {
                drawPinIcon(rightColX, currentY - 4, 3);
            }
        }
    });

    return doc;
  };

  return (
    <div className="min-h-screen bg-stone-100 text-stone-900 font-sans">
      <header className="bg-white border-b border-stone-200 p-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-stone-900 text-white flex items-center justify-center rounded-lg">
              <Calendar size={20} />
            </div>
            <h1 className="text-xl font-bold tracking-tight">Remarcal Clone</h1>
          </div>
          <div className="flex items-center gap-4">
             <button onClick={() => setShowHelp(true)} className="text-sm text-stone-500 hover:text-stone-900">
               How to Upload?
             </button>
          </div>
        </div>
      </header>

      {showHelp && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-8 max-w-md w-full shadow-xl">
            <h3 className="text-xl font-bold mb-4">How to Upload to reMarkable</h3>
            <ol className="list-decimal list-inside space-y-3 text-stone-600 mb-6">
              <li>Generate and download the PDF planner.</li>
              <li>Open the <strong>reMarkable Desktop App</strong> or mobile app.</li>
              <li>Drag and drop the downloaded PDF into the app.</li>
              <li>Wait for it to sync to your tablet.</li>
              <li>On your tablet, open the file. You can now write on it!</li>
            </ol>
            <button 
              onClick={() => setShowHelp(false)}
              className="w-full bg-stone-900 text-white py-2 rounded-lg font-medium"
            >
              Got it
            </button>
          </div>
        </div>
      )}

      <main className="max-w-5xl mx-auto p-6">
        {state.step === 'config' && (
          <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-sm border border-stone-200 overflow-hidden">
            <div className="flex border-b border-stone-200">
                <button 
                    className={`flex-1 py-4 font-medium text-sm ${state.activeTab === 'general' ? 'border-b-2 border-black text-black' : 'text-gray-500 hover:text-gray-700'}`}
                    onClick={() => setState(prev => ({ ...prev, activeTab: 'general' }))}
                >
                    General
                </button>
                <button 
                    className={`flex-1 py-4 font-medium text-sm ${state.activeTab === 'caldav' ? 'border-b-2 border-black text-black' : 'text-gray-500 hover:text-gray-700'}`}
                    onClick={() => setState(prev => ({ ...prev, activeTab: 'caldav' }))}
                >
                    Data Source
                </button>
                <button 
                    className={`flex-1 py-4 font-medium text-sm ${state.activeTab === 'device' ? 'border-b-2 border-black text-black' : 'text-gray-500 hover:text-gray-700'}`}
                    onClick={() => setState(prev => ({ ...prev, activeTab: 'device' }))}
                >
                    Device (SSH)
                </button>
            </div>

            <div className="p-8">
                {state.error && (
                  <div className="mb-6 p-4 bg-red-50 text-red-700 rounded-lg flex items-start gap-3">
                    <AlertCircle className="shrink-0 mt-0.5" size={18} />
                    <p className="text-sm">{state.error}</p>
                  </div>
                )}

                {state.activeTab === 'general' && (
                    <div className="space-y-6">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">Year</label>
                            <input
                                type="number"
                                name="year"
                                value={state.config.year}
                                onChange={handleInputChange}
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-black focus:border-transparent"
                            />
                        </div>
                        <div className="flex items-center gap-3 py-2">
                            <input 
                                type="checkbox" 
                                id="dotgrid"
                                checked={showDotGrid}
                                onChange={(e) => setShowDotGrid(e.target.checked)}
                                className="w-5 h-5 rounded border-stone-300 text-stone-900 focus:ring-stone-900"
                            />
                            <label htmlFor="dotgrid" className="text-sm font-medium">Add Dot Grid Background</label>
                        </div>
                    </div>
                )}

                {state.activeTab === 'caldav' && (
                    <div className="space-y-6">
                        <div className="flex items-center space-x-4 mb-6">
                            <button
                                className={`px-4 py-2 rounded-lg text-sm font-medium ${state.dataSource === 'mock' ? 'bg-black text-white' : 'bg-gray-100 text-gray-700'}`}
                                onClick={() => setState(prev => ({ ...prev, dataSource: 'mock' }))}
                            >
                                Use Mock Data
                            </button>
                            <button
                                className={`px-4 py-2 rounded-lg text-sm font-medium ${state.dataSource === 'caldav' ? 'bg-black text-white' : 'bg-gray-100 text-gray-700'}`}
                                onClick={() => setState(prev => ({ ...prev, dataSource: 'caldav' }))}
                            >
                                Use CalDAV
                            </button>
                        </div>

                        {state.dataSource === 'caldav' && (
                            <>
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-2">CalDAV URL</label>
                                    <input
                                        type="text"
                                        name="caldavUrl"
                                        value={state.config.caldavUrl}
                                        onChange={handleInputChange}
                                        placeholder="https://caldav.example.com/calendars/user/calendar/"
                                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-black focus:border-transparent"
                                    />
                                </div>
                                <div className="grid grid-cols-2 gap-6">
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 mb-2">Username</label>
                                        <input
                                            type="text"
                                            name="username"
                                            value={state.config.username}
                                            onChange={handleInputChange}
                                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-black focus:border-transparent"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 mb-2">Password / App Token</label>
                                        <input
                                            type="password"
                                            name="password"
                                            value={state.config.password}
                                            onChange={handleInputChange}
                                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-black focus:border-transparent"
                                        />
                                    </div>
                                </div>
                            </>
                        )}
                        {state.dataSource === 'mock' && (
                            <div className="p-4 bg-gray-50 rounded-lg text-sm text-gray-600">
                                Using built-in mock data for demonstration purposes. No connection required.
                            </div>
                        )}
                    </div>
                )}

                {state.activeTab === 'device' && (
                    <div className="space-y-6">
                        <div className="grid grid-cols-2 gap-6">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">Device IP</label>
                                <input
                                    type="text"
                                    name="host"
                                    value={state.sshConfig.host}
                                    onChange={handleInputChange}
                                    placeholder="10.11.99.1"
                                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-black focus:border-transparent"
                                />
                                <p className="mt-1 text-xs text-gray-500">Default USB IP: 10.11.99.1</p>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">Username</label>
                                <input
                                    type="text"
                                    name="username"
                                    value={state.sshConfig.username}
                                    onChange={handleInputChange}
                                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-black focus:border-transparent"
                                />
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-6">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">Password (Optional)</label>
                                <input
                                    type="password"
                                    name="password"
                                    value={state.sshConfig.password || ''}
                                    onChange={handleInputChange}
                                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-black focus:border-transparent"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">Private Key (PEM) (Optional)</label>
                                <textarea
                                    name="privateKey"
                                    value={state.sshConfig.privateKey}
                                    onChange={handleInputChange}
                                    rows={1}
                                    placeholder="-----BEGIN RSA PRIVATE KEY-----..."
                                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-black focus:border-transparent font-mono text-xs"
                                />
                            </div>
                        </div>
                        <div className="flex justify-end">
                            <button
                                onClick={fetchDocuments}
                                disabled={!state.sshConfig.host || !state.sshConfig.privateKey || state.syncStatus === 'listing'}
                                className="flex items-center px-4 py-2 bg-gray-800 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50"
                            >
                                {state.syncStatus === 'listing' ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
                                Test Connection & List Files
                            </button>
                        </div>
                        
                        {state.syncStatus === 'error' && (
                            <div className="p-4 bg-red-50 text-red-700 rounded-lg text-sm">
                                {state.syncMessage}
                            </div>
                        )}
                        
                        {state.documents.length > 0 && (
                            <div className="mt-4 border rounded-lg overflow-hidden">
                                <div className="bg-gray-50 px-4 py-2 border-b font-medium text-sm">Available Documents</div>
                                <div className="max-h-48 overflow-y-auto">
                                    {state.documents.map(doc => (
                                        <div 
                                            key={doc.uuid}
                                            className={`px-4 py-2 border-b last:border-0 cursor-pointer hover:bg-gray-50 flex justify-between items-center ${state.selectedDocumentUuid === doc.uuid ? 'bg-blue-50' : ''}`}
                                            onClick={() => setState(prev => ({ ...prev, selectedDocumentUuid: doc.uuid }))}
                                        >
                                            <span className="text-sm font-medium">{doc.name}</span>
                                            <span className="text-xs text-gray-500">{new Date(doc.lastModified).toLocaleDateString()}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>

            <div className="bg-gray-50 px-8 py-4 border-t border-stone-200 flex justify-end">
              <button
                onClick={() => {
                    if (state.dataSource === 'caldav') {
                        fetchCalDavEvents();
                    } else {
                        loadMockData();
                    }
                }}
                disabled={loading}
                className="flex items-center px-6 py-3 bg-stone-900 text-white rounded-lg hover:bg-stone-800 transition-colors disabled:opacity-50 shadow-lg shadow-stone-900/20"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Calendar className="w-5 h-5 mr-2" />
                    Generate Planner
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {state.step === 'preview' && (
          <div className="h-[calc(100vh-8rem)] flex flex-col bg-white rounded-2xl shadow-sm border border-stone-200 overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200">
              <button
                onClick={() => setState(prev => ({ ...prev, step: 'config' }))}
                className="text-sm font-medium text-stone-500 hover:text-stone-900 flex items-center gap-1"
              >
                ← Back to Config
              </button>
              
              <div className="flex items-center gap-3">
                {state.selectedDocumentUuid && (
                    <div className="text-xs text-gray-500 mr-2 hidden md:block">
                        Target: {state.documents.find(d => d.uuid === state.selectedDocumentUuid)?.name || state.selectedDocumentUuid}
                    </div>
                )}
                
                <button
                    onClick={() => {
                        const doc = generatePDF();
                        if (doc) {
                            const blob = doc.output('blob');
                            syncDocument(blob, doc.getNumberOfPages());
                        }
                    }}
                    disabled={!state.selectedDocumentUuid || state.syncStatus === 'syncing'}
                    className="flex items-center px-4 py-2 bg-gray-800 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
                >
                    {state.syncStatus === 'syncing' ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                        <Upload className="w-4 h-4 mr-2" />
                    )}
                    Sync to Device
                </button>

                <button
                  onClick={() => {
                      const doc = generatePDF();
                      if (doc) doc.save('remarkable-planner.pdf');
                  }}
                  className="flex items-center px-4 py-2 bg-stone-900 text-white rounded-lg hover:bg-stone-800 text-sm font-medium"
                >
                  <Download className="w-4 h-4 mr-2" />
                  Download PDF
                </button>
              </div>
            </div>

            {state.syncMessage && (
                <div className={`px-6 py-2 text-xs text-center ${state.syncStatus === 'error' ? 'bg-red-100 text-red-800' : 'bg-blue-50 text-blue-800'}`}>
                    {state.syncMessage}
                </div>
            )}

            <div className="flex-1 bg-stone-100 p-8 overflow-hidden">
              <div className="h-full max-w-4xl mx-auto bg-white shadow-xl rounded-lg overflow-hidden">
                <iframe
                  id="pdf-preview"
                  className="w-full h-full"
                  title="PDF Preview"
                />
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

