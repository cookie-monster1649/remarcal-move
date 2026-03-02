import { jsPDF } from 'jspdf';
import { format, addDays, startOfWeek, endOfWeek, startOfMonth, endOfMonth, eachDayOfInterval, isSameMonth, isSameDay, parseISO } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';

export interface CalendarEvent {
  summary: string;
  start: Date;
  end: Date;
  description?: string;
  location?: string;
  allDay?: boolean;
}

export interface PDFConfig {
  year: number;
  timezone: string;
}

export class PDFService {
  generate(events: CalendarEvent[], config: PDFConfig): Buffer {
    const tz = config.timezone || 'UTC';
    
    // Helper to get date string in target timezone
    const getTzDateStr = (date: Date) => formatInTimeZone(date, tz, 'yyyy-MM-dd');
    const getTzTimeStr = (date: Date) => formatInTimeZone(date, tz, 'HH:mm');
    const getTzHour = (date: Date) => {
        const h = parseInt(formatInTimeZone(date, tz, 'H'));
        const m = parseInt(formatInTimeZone(date, tz, 'm'));
        return h + m / 60;
    };

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
    const start = new Date(config.year, 0, 1);
    const end = new Date(config.year, 11, 31);
    
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
      if (monthKey !== currentMonthKey && day.getDate() === 1) {
        currentPage++;
        pageMap.months[monthKey] = currentPage;
        currentMonthKey = monthKey;
      }
      
      // New Week?
      if (weekKey !== currentWeekKey) {
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
        const navY = 15;
        const navH = 7;
        const navW = pageWidth - 10;
        const navX = 5;
        
        doc.setDrawColor(0);
        doc.setLineWidth(0.3);
        doc.roundedRect(navX, navY, navW, navH, 2, 2, 'S');
        
        doc.setFontSize(7); 
        doc.setFont("helvetica", "normal");
        doc.setTextColor(0);
        
        let cursorX = navX + 2;
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
        
        const yearSectionW = 11; 
        const weekSectionW = showWeek ? 14 : 0; 
        const padding = 0; 
        const availableW = navW - yearSectionW - weekSectionW - padding;
        const monthSlotW = availableW / 12;
        
        months.forEach((m, i) => {
            const mDate = new Date(currentDate.getFullYear(), i, 1);
            const mKey = format(mDate, 'yyyy-MM');
            const targetPage = pageMap.months[mKey];
            
            const slotX = cursorX + (i * monthSlotW);
            const textW = doc.getTextWidth(m);
            const textX = slotX + (monthSlotW - textW) / 2;
            
            if (i === currentDate.getMonth()) {
                doc.setFillColor(50, 50, 50);
                doc.roundedRect(textX - 1, navY + 1.5, textW + 2, 4, 1, 1, 'F');
                doc.setTextColor(255);
            } else {
                doc.setTextColor(0);
            }
            
            doc.text(m, textX, centerY);
            
            if (targetPage) {
                doc.link(slotX, navY + 1, monthSlotW, 4, { pageNumber: targetPage });
            }
            
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
            
            const weekWidth = 10;
            const weekX = navX + navW - weekWidth - 2;
            
            doc.setTextColor(0);
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
    doc.text(`${config.year} Calendar`, pageWidth / 2, 10, { align: 'center' });
    
    const yMargin = 15;
    const yColWidth = (pageWidth - 20) / 3;
    const yRowHeight = (pageHeight - 30) / 4;
    
    for (let i = 0; i < 12; i++) {
        const mDate = new Date(config.year, i, 1);
        const col = i % 3;
        const row = Math.floor(i / 3);
        const x = 10 + (col * yColWidth);
        const y = yMargin + (row * yRowHeight);
        
        doc.setFontSize(10);
        doc.setFont("helvetica", "normal");
        doc.text(format(mDate, 'MMMM'), x + yColWidth/2, y + 5, { align: 'center' });
        
        const mKey = format(mDate, 'yyyy-MM');
        if (pageMap.months[mKey]) {
            const textWidth = doc.getTextWidth(format(mDate, 'MMMM'));
            doc.link(x + yColWidth/2 - textWidth/2 - 2, y, textWidth + 4, 6, { pageNumber: pageMap.months[mKey] });
        }
        
        doc.setFontSize(6);
        doc.setFont("helvetica", "normal");
        const daysInMonth = eachDayOfInterval({ start: startOfMonth(mDate), end: endOfMonth(mDate) });
        let startDay = startOfMonth(mDate).getDay();
        startDay = startDay === 0 ? 6 : startDay - 1;
        
        const cellW = (yColWidth - 4) / 7;
        const cellH = 3;
        
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
            
            const hasEvent = events.some(e => getTzDateStr(e.start) === format(d, 'yyyy-MM-dd'));
            if (hasEvent) {
                doc.setFont("helvetica", "bold");
                doc.setFillColor(220, 220, 220);
                doc.circle(dX + cellW/2, dY - 1, 1.5, 'F');
            } else {
                doc.setFont("helvetica", "normal");
            }
            
            doc.text(date.toString(), dX + cellW/2, dY, { align: 'center' });
            
            const dKey = format(d, 'yyyy-MM-dd');
            if (pageMap.days[dKey]) {
                doc.link(dX, dY - 2, cellW, cellH, { pageNumber: pageMap.days[dKey] });
            }
        });
    }

    // --- Chronological Pages ---
    
    currentMonthKey = '';
    currentWeekKey = '';
    const renderedWeeks = new Set<string>();

    allDays.forEach((day) => {
        const monthKey = format(day, 'yyyy-MM');
        const weekKey = format(day, 'yyyy-ww', { weekStartsOn: 1 });
        
        // --- Month View ---
        if (monthKey !== currentMonthKey && day.getDate() === 1) {
            doc.addPage();
            currentMonthKey = monthKey;
            
            doc.setFontSize(14);
            doc.setFont("helvetica", "normal");
            doc.text(format(day, 'MMMM yyyy'), pageWidth / 2, 10, { align: 'center' });
            
            drawNavBar(day, false);
            
            const mStart = startOfMonth(day);
            const mEnd = endOfMonth(day);
            const gridStart = startOfWeek(mStart, { weekStartsOn: 1 });
            const gridEnd = endOfWeek(mEnd, { weekStartsOn: 1 });
            
            const mDays = eachDayOfInterval({ start: gridStart, end: gridEnd });
            
            const gridX = 8;
            const gridY = 25; 
            const gridW = pageWidth - 13;
            const gridH = pageHeight - 35;
            const cellW = gridW / 7;
            const cellH = gridH / 6; 
            
            doc.setDrawColor(0);
            doc.setLineWidth(0.1);
            for(let i=0; i<=7; i++) doc.line(gridX + i*cellW, gridY, gridX + i*cellW, gridY + 6*cellH);
            for(let i=0; i<=6; i++) doc.line(gridX, gridY + i*cellH, gridX + gridW, gridY + i*cellH);
            
            doc.setFontSize(7);
            doc.setFont("helvetica", "bold");
            doc.setTextColor(150);
            for(let i=0; i<6; i++) {
                const wDate = addDays(gridStart, i*7);
                if (i * 7 < mDays.length) {
                    const wNum = format(wDate, 'ww', { weekStartsOn: 1 });
                    const wKey = format(wDate, 'yyyy-ww', { weekStartsOn: 1 });
                    const yPos = gridY + i*cellH + cellH/2;
                    
                    doc.text(`W${wNum}`, 1, yPos);
                    
                    if (pageMap.weeks[wKey]) {
                        doc.link(0, gridY + i*cellH, 8, cellH, { pageNumber: pageMap.weeks[wKey] });
                    }
                }
            }

            mDays.forEach((d, idx) => {
                const r = Math.floor(idx / 7);
                const c = idx % 7;
                
                if (r > 5) return;

                const x = gridX + c*cellW;
                const y = gridY + r*cellH;
                
                const isCurrentMonth = isSameMonth(d, day);
                doc.setTextColor(isCurrentMonth ? 0 : 150);
                
                doc.setFontSize(7);
                doc.setFont("helvetica", "bold");
                const dayName = format(d, 'EEE');
                doc.text(dayName, x + 2, y + 4);

                doc.setFontSize(9);
                doc.setFont("helvetica", "normal");
                doc.setTextColor(150);
                doc.text(d.getDate().toString(), x + cellW - 2, y + 4, { align: 'right' });
                
                const dKey = format(d, 'yyyy-MM-dd');
                if (pageMap.days[dKey]) {
                    doc.link(x, y, cellW, cellH, { pageNumber: pageMap.days[dKey] });
                }
                
                const dayEvents = events.filter(e => getTzDateStr(e.start) === format(d, 'yyyy-MM-dd'));
                let eventY = y + 8;
                doc.setFontSize(5);
                doc.setTextColor(0);
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
             
             doc.setFontSize(12);
             doc.setFont("helvetica", "normal");
             doc.text(`Week ${format(day, 'ww', { weekStartsOn: 1 })} | ${format(wStart, 'MMM d')} - ${format(wEnd, 'MMM d')}`, pageWidth/2, 10, { align: 'center' });
             
             drawNavBar(day);
             
             const gridX = 5;
             const gridY = 25;
             const gridW = pageWidth - 10;
             const gridH = pageHeight - 35;
             const cellW = gridW / 3;
             const cellH = gridH / 3;
             
             const weekDays = eachDayOfInterval({ start: wStart, end: wEnd });
             
             const gridMap = [
                 {c:0, r:0}, {c:1, r:0}, {c:2, r:0},
                 {c:0, r:1}, {c:1, r:1},
                 {c:0, r:2}, {c:1, r:2},
             ];
             
             weekDays.forEach((d, i) => {
                 const pos = gridMap[i];
                 const x = gridX + pos.c*cellW;
                 const y = gridY + pos.r*cellH;
                 
                 doc.setDrawColor(0);
                 doc.setLineWidth(0.1);
                 doc.rect(x, y, cellW, cellH);
                 
                 doc.setFontSize(10);
                 doc.setFont("helvetica", "bold");
                 doc.setTextColor(0);
                 const dayName = format(d, 'EEE');
                 doc.text(dayName, x + cellW - 12, y + 6, { align: 'right' });
                 
                 doc.setFont("helvetica", "normal");
                 doc.setTextColor(150);
                 const dateNum = format(d, 'd');
                 doc.text(dateNum, x + cellW - 4, y + 6, { align: 'right' });
                 
                 const dKey = format(d, 'yyyy-MM-dd');
                 if (pageMap.days[dKey]) {
                     doc.link(x, y, cellW, 8, { pageNumber: pageMap.days[dKey] });
                 }
                 
                 const dayEvents = events.filter(e => getTzDateStr(e.start) === format(d, 'yyyy-MM-dd'));
                 let eventY = y + 12;
                 doc.setFontSize(6);
                 doc.setFont("helvetica", "normal");
                 doc.setTextColor(0);
                 dayEvents.forEach(e => {
                     if (eventY < y + cellH - 5) {
                         const time = getTzTimeStr(e.start);
                         const summary = truncate(e.summary, 20);
                         doc.roundedRect(x + 2, eventY, cellW - 4, 5, 1, 1, 'S');
                         doc.text(`${time} ${summary}`, x + 3, eventY + 3.5);
                         eventY += 6;
                     }
                 });
             });
             
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
        
        doc.setFontSize(14);
        doc.setFont("helvetica", "normal");
        doc.text(format(day, 'EEEE, MMMM d, yyyy'), pageWidth/2, 10, { align: 'center' });
        
        drawNavBar(day);
        
        const contentY = 25; 
        const allDayH = 10; 
        const mainContentY = contentY + allDayH + 8;
        const mainContentH = pageHeight - mainContentY - 10;
        
        const leftColW = (pageWidth - 15) * 0.6;
        const rightColX = 5 + leftColW + 5;
        const rightColW = pageWidth - rightColX - 5;
        
        doc.setDrawColor(200);
        doc.setLineWidth(0.2);
        doc.roundedRect(5, contentY, pageWidth - 10, allDayH, 2, 2, 'S');
        doc.setFontSize(8);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(150);
        doc.text("All day", 7, contentY + 6); 
        
        const allDayEvents = events.filter(e => {
            const duration = e.end.getTime() - e.start.getTime();
            const isMidnight = parseInt(formatInTimeZone(e.start, tz, 'H')) === 0 && parseInt(formatInTimeZone(e.start, tz, 'm')) === 0;
            return getTzDateStr(e.start) === format(day, 'yyyy-MM-dd') && (duration >= 86400000 || isMidnight);
        });
        
        let adX = 35; 
        allDayEvents.forEach(e => {
            doc.setFontSize(7);
            const summary = truncate(e.summary, 30);
            const textW = doc.getTextWidth(summary) + 4;
            
            doc.setFillColor(245, 245, 245);
            doc.setDrawColor(100);
            doc.setLineWidth(0.1);
            doc.roundedRect(adX, contentY + 2, textW, 6, 1, 1, 'FD');
            
            doc.setTextColor(0);
            doc.text(summary, adX + 2, contentY + 6);
            adX += textW + 2; 
        });
        
        doc.setTextColor(0);
        doc.setFontSize(11);
        doc.text("Schedule", 5, mainContentY - 3);
        doc.setLineWidth(0.3);
        doc.setDrawColor(0);
        doc.line(5, mainContentY, 5 + leftColW, mainContentY);
        
        const startHour = 5;
        const endHour = 24; 
        const totalHours = endHour - startHour;
        const hourH = mainContentH / totalHours;
        
        for (let h = startHour; h <= endHour; h++) {
            const y = mainContentY + (h - startHour) * hourH;
            doc.setLineWidth(0.1);
            doc.setDrawColor(200); 
            doc.line(5, y, 5 + leftColW, y);
            
            if (h < endHour) {
                doc.setFontSize(7);
                doc.setTextColor(100);
                // We just need a label for the hour, so any date will do
                const timeLabel = format(new Date().setHours(h, 0), 'h a');
                doc.text(timeLabel, 5, y + 3);
            }
        }
        
        const dayEvents = events.filter(e => {
            const duration = e.end.getTime() - e.start.getTime();
            const isMidnight = parseInt(formatInTimeZone(e.start, tz, 'H')) === 0 && parseInt(formatInTimeZone(e.start, tz, 'm')) === 0;
            if (duration >= 86400000 || isMidnight) return false;
            return getTzDateStr(e.start) === format(day, 'yyyy-MM-dd');
        });
        
        const items = dayEvents.map(e => {
            let startH = getTzHour(e.start);
            let endH = getTzHour(e.end);
            if (endH < startH) endH += 24;
            
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

        const drawPinIcon = (x: number, y: number, size: number) => {
            doc.setFillColor(100, 100, 100);
            const r = size / 2.5;
            const cy = y + r;
            const cx = x + size / 2;
            
            doc.triangle(cx - r*0.8, cy + r*0.2, cx + r*0.8, cy + r*0.2, cx, y + size, 'F');
            doc.circle(cx, cy, r, 'F');
            doc.setFillColor(255, 255, 255);
            doc.circle(cx, cy, r * 0.4, 'F');
        };

        clusters.forEach(cluster => {
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
            
            const totalCols = columns.length;
            const scheduleW = leftColW - 15;
            const colW = scheduleW / totalCols;
            const scheduleRightEdge = 5 + leftColW;
            
            cluster.forEach(item => {
                const y = mainContentY + (item.start - startHour) * hourH;
                const h = (item.end - item.start) * hourH;
                const x = 15 + (item.colIndex * colW);
                
                const rectW = scheduleRightEdge - x;
                
                doc.setFillColor(245, 245, 245);
                doc.setDrawColor(100);
                doc.setLineWidth(0.1);
                doc.roundedRect(x, y, rectW, h, 1, 1, 'FD');
                
                let visibleW = rectW;
                
                if (item.colIndex < totalCols - 1) {
                    let nextColStart = item.end;
                    
                    const overlappingItems = cluster.filter(ci => 
                        ci.colIndex > item.colIndex && 
                        ci.start < item.end && 
                        ci.end > item.start
                    );
                    
                    if (overlappingItems.length > 0) {
                        const earliestOverlap = Math.min(...overlappingItems.map(ci => ci.start));
                        if (earliestOverlap < item.start + 0.5) {
                             visibleW = colW;
                        }
                    }
                }

                doc.setTextColor(0);
                
                const isShortEvent = h < 4;
                const fontSize = isShortEvent ? 6 : 8;
                doc.setFontSize(fontSize);
                doc.setFont("helvetica", "normal");
                
                const hasLocation = !!item.event.location;
                
                const iconSize = 2; 
                const iconPadding = 1;
                
                const availableWidth = visibleW - 4 - (hasLocation ? iconSize + iconPadding : 0);
                
                let textLines: string[] = [];
                const summary = item.event.summary;
                
                const lineHeight = isShortEvent ? 2.5 : 3.5;
                const maxLines = Math.floor((h - 1) / lineHeight);
                
                if (maxLines <= 1 || isShortEvent) {
                    let text = summary;
                    if (doc.getTextWidth(text) > availableWidth) {
                        while (doc.getTextWidth(text + '...') > availableWidth && text.length > 0) {
                            text = text.slice(0, -1);
                        }
                        text += '...';
                    }
                    textLines = [text];
                } else {
                    const lines = doc.splitTextToSize(summary, availableWidth);
                    if (lines.length > maxLines) {
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
                
                let textY = y + 3;
                
                if (isShortEvent) {
                     const textHeight = fontSize * 0.3527;
                     textY = y + h/2 + textHeight/2 - 0.5;
                }
                
                doc.text(textLines, x + 2, textY);

                if (hasLocation) {
                    locationsForNotes.push({ summary: item.event.summary, location: item.event.location! });
                    
                    const iconX = x + visibleW - 2 - iconSize;
                    
                    let iconY = y + 1.5;
                    if (isShortEvent) {
                        iconY = y + (h - iconSize) / 2;
                    }
                    
                    drawPinIcon(iconX, iconY, iconSize);
                }
            });
        });
        
        doc.setTextColor(0);
        doc.setFontSize(11);
        doc.text("Tasks", rightColX, mainContentY - 3);
        doc.setLineWidth(0.3);
        doc.setDrawColor(0);
        doc.line(rightColX, mainContentY, rightColX + rightColW, mainContentY);
        
        const taskCount = 5;
        const taskItemH = 8;
        const taskSectionH = taskCount * taskItemH;
        
        for(let i=0; i<taskCount; i++) {
            const y = mainContentY + (i * taskItemH) + 6;
            
            doc.setLineWidth(0.1);
            doc.setDrawColor(0);
            doc.circle(rightColX + 3, y - 1.5, 1.5);
            
            doc.setDrawColor(200);
            doc.line(rightColX + 8, y, rightColX + rightColW, y);
        }
        
        const notesY = mainContentY + taskSectionH + 10;
        doc.setTextColor(0);
        doc.setFontSize(11);
        doc.text("Notes", rightColX, notesY - 3);
        doc.setLineWidth(0.3);
        doc.setDrawColor(0);
        doc.line(rightColX, notesY, rightColX + rightColW, notesY);
        
        const notesBottom = mainContentY + mainContentH;
        const notesH = notesBottom - notesY;
        const lineGap = 8;
        const lineCount = Math.floor(notesH / lineGap);
        
        for(let i=0; i<lineCount; i++) {
            const y = notesY + ((i+1) * lineGap);
            doc.setLineWidth(0.1);
            doc.setDrawColor(200);
            doc.line(rightColX, y, rightColX + rightColW, y);
        }
        
        if (locationsForNotes.length > 0) {
            doc.setFontSize(7);
            doc.setTextColor(80);
            
            const uniqueLocs = Array.from(new Set(locationsForNotes.map(l => `${l.summary}: ${l.location}`)));
            
            const maxW = rightColW;
            let currentY = notesBottom - 2;
            
            [...uniqueLocs].reverse().forEach(locStr => {
                const safeStr = locStr.length > 200 ? locStr.substring(0, 200) + '...' : locStr;
                
                const lines = doc.splitTextToSize(safeStr, maxW);
                const blockH = lines.length * 3;
                
                if (currentY - blockH > notesY + 8) {
                    doc.text(lines, rightColX, currentY - blockH + 2.5);
                    currentY -= (blockH + 1);
                }
            });
            
            if (currentY > notesY + 5) {
                drawPinIcon(rightColX, currentY - 4, 3);
            }
        }
    });

    return Buffer.from(doc.output('arraybuffer'));
  }
}
