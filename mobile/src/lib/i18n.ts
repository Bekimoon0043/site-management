// Lightweight i18n: typed t(key) with English + Amharic dictionaries, plus the
// calendar preference (Gregorian / Ethiopian) used by the shared date formatter.
// State lives in kv (`ui:locale`, `ui:calendar`) so it works offline and outside
// React; useLocale() subscribes components. Missing Amharic keys fall back to English.
import { useSyncExternalStore } from 'react';
import { bump, kvGet, kvSet } from './db';

export type Locale = 'en' | 'am';
export type Calendar = 'gregorian' | 'ethiopian';
export interface LocalePrefs { locale: Locale; calendar: Calendar }

const en = {
  // navigation
  'tab.home': 'Home', 'tab.issue': 'Issue', 'tab.requests': 'Requests', 'tab.approvals': 'Approvals', 'tab.review': 'Review',
  'tab.stock': 'Stock', 'tab.progress': 'Progress', 'tab.docs': 'Docs', 'tab.more': 'More',
  'title.issueQueue': 'Issue queue', 'title.storeDocs': 'Store documents', 'title.settings': 'Settings', 'title.search': 'Search',
  'title.notifications': 'Notifications', 'title.sync': 'Sync status', 'title.alerts': 'Alerts',
  // home
  'home.morning': 'Good morning', 'home.afternoon': 'Good afternoon', 'home.evening': 'Good evening',
  'home.needsYou': 'Needs you', 'home.seeAll': 'See all {n}', 'home.nothing': 'Nothing waiting for you',
  'home.nothingBody': 'New tasks show up here as soon as they arrive.', 'home.today': 'Today', 'home.quick': 'Quick actions',
  'home.moreActions': 'More actions', 'home.receive': 'Receive delivery', 'home.receiveHint': 'Goods receipt with inspection',
  'home.newRequest': 'New request', 'home.newRequestHint': 'Materials for your elements', 'home.lookahead': 'Look-ahead request',
  'home.lookaheadHint': 'Plan materials for the next weeks', 'home.criticalAlerts': '{n} critical alert(s)', 'home.criticalAlertsSub': 'Open alerts that need action',
  'home.posToApprove': '{n} purchase order(s) to approve', 'home.gateToApprove': '{n} gate pass(es) to approve',
  'home.expected': 'Expected deliveries', 'home.delayed': '{n} delayed', 'home.syncRejected': '{n} change(s) rejected by the server',
  'home.syncFix': 'Tap to fix or discard',
  // KPIs
  'kpi.awaitingIssue': 'Awaiting issue', 'kpi.lowStock': 'Low stock', 'kpi.due': 'Due / overdue', 'kpi.transfersIn': 'Transfers in',
  'kpi.myOpen': 'My open requests', 'kpi.issuedToMe': 'Issued to me', 'kpi.activeElements': 'Active elements',
  'kpi.delayedElements': 'Delayed elements', 'kpi.awaitingReview': 'Awaiting review', 'kpi.toVerify': 'Progress to verify',
  'kpi.boqAlerts': 'BoQ alerts', 'kpi.overall': 'Overall progress', 'kpi.pendingApprovals': 'Pending approvals',
  'kpi.shortages': 'Critical shortages', 'kpi.toSource': 'Approved, to source', 'kpi.lookahead14': 'Look-ahead 14 days',
  'kpi.expected': 'Expected deliveries', 'kpi.openPos': 'Open POs', 'kpi.reorder': 'Reorder suggestions',
  // actions
  'act.issue': 'Issue', 'act.return': 'Return', 'act.count': 'Count', 'act.wastage': 'Wastage', 'act.transfer': 'Transfer',
  'act.more': 'More…', 'act.updateProgress': 'Update progress', 'act.requests': 'Requests', 'act.signOff': 'Sign off',
  'act.stock': 'Stock', 'act.search': 'Search', 'act.verifyProgress': 'Verify progress', 'act.elements': 'Elements',
  'act.documents': 'Documents', 'act.approvals': 'Approvals', 'act.progress': 'Progress', 'act.stockReport': 'Stock report',
  'act.gatePass': 'Gate pass', 'act.alerts': 'Alerts', 'act.purchaseOrders': 'Purchase orders', 'act.logPrice': 'Log price',
  'act.reorder': 'Reorder', 'act.expected': 'Expected',
  // common
  'common.save': 'Save', 'common.cancel': 'Cancel', 'common.approve': 'Approve', 'common.reject': 'Reject', 'common.submit': 'Submit',
  'common.done': 'Done', 'common.retry': 'Retry', 'common.close': 'Close', 'common.acknowledge': 'Acknowledge', 'common.scan': 'Scan',
  'common.search': 'Search', 'common.next': 'Next', 'common.back': 'Back', 'common.addItem': 'Add item', 'common.remove': 'Remove item',
  'common.confirm': 'Confirm', 'common.settings': 'Settings', 'common.signOut': 'Sign out', 'common.optional': 'optional',
  'common.remarks': 'Remarks', 'common.items': 'Items', 'common.store': 'Store', 'common.supplier': 'Supplier',
  'common.material': 'Material / grade', 'common.quantity': 'Quantity', 'common.plate': 'Plate', 'common.driver': 'Driver',
  'common.date': 'Date', 'common.status': 'Status', 'common.all': 'All', 'common.open': 'Open', 'common.savedOnPhone': '{x} saved on phone',
  'common.notOnPhone': 'Not on this phone yet', 'common.allCaught': 'All caught up', 'common.never': 'never',
  'common.justNow': 'just now', 'common.minAgo': '{n} min ago', 'common.hAgo': '{n} h ago', 'common.daysAgo': '{n} days ago',
  // status labels
  'status.draft': 'Draft', 'status.submitted': 'Submitted', 'status.reviewed': 'Reviewed', 'status.returned': 'Returned',
  'status.approved': 'Approved', 'status.sourced': 'Sourced', 'status.ordered': 'Ordered', 'status.partially_issued': 'Part issued',
  'status.issued': 'Issued', 'status.closed': 'Closed', 'status.rejected': 'Rejected', 'status.cancelled': 'Cancelled',
  'status.pending_ack': 'Awaiting sign-off', 'status.acknowledged': 'Acknowledged', 'status.posted': 'Posted',
  'status.reversed': 'Reversed', 'status.in_transit': 'In transit', 'status.received': 'Received', 'status.pending': 'Pending',
  'status.adjusted': 'Adjusted', 'status.reported': 'To verify', 'status.verified': 'Verified', 'status.not_started': 'Not started',
  'status.in_progress': 'In progress', 'status.completed': 'Completed', 'status.on_hold': 'On hold', 'status.hold_point': 'Hold point',
  'status.exited': 'Left site', 'status.partially_returned': 'Part returned', 'status.sent': 'Sent to supplier',
  'status.partially_received': 'Part received', 'status.open': 'Open', 'status.delayed': 'Delayed', 'status.overdue': 'Overdue',
  'status.on_loan': 'On loan', 'status.critical': 'Critical', 'status.warning': 'Warning', 'status.info': 'Info',
  // store flows
  'grn.title': 'Receive delivery', 'grn.searchArriving': 'Search request, PO or material', 'grn.adhoc': 'Delivery without a request',
  'grn.expectedMr': 'Expected · approved, not fully received', 'grn.expectedPo': 'Purchase orders · outstanding',
  'grn.noneWaiting': 'No approved requests waiting', 'grn.noneWaitingBody': 'You can still receive a delivery without a request.',
  'grn.post': 'Post GRN', 'grn.receivingStore': 'Receiving store', 'grn.dn': 'Delivery note no.', 'grn.received': 'Received',
  'grn.receiveAnother': 'Receive another', 'grn.stockUpdated': 'Stock is updated now. It will sync automatically.',
  'grn.allOk': 'All OK', 'grn.short': 'Short', 'grn.damaged': 'Damaged', 'grn.photos': 'Delivery note & photos',
  'grn.signature': 'Supplier / driver signature', 'grn.againstPo': 'Against {po}', 'grn.ordered': 'ordered {q}', 'grn.due': 'due {q}',
  'issue.title': 'Issue materials', 'issue.post': 'Post issue', 'issue.issuedTo': 'Issued to', 'issue.element': 'Structural element',
  'issue.emergency': 'Emergency issue (no request)', 'issue.receiverSig': 'Receiver signature',
  'mr.new': 'New request', 'mr.submit': 'Submit request', 'mr.saveDraft': 'Save draft', 'mr.requiredDate': 'Required date',
  'mr.block': 'Block', 'mr.priority': 'Priority', 'mr.purpose': 'Purpose', 'mr.addMaterial': 'Add material',
  'progress.title': 'Elements & progress', 'progress.report': 'Report progress', 'progress.verify': 'Verify progress',
  'progress.save': 'Save progress', 'progress.pct': 'Complete (%)',
  'issue.issued': 'Issued', 'issue.approvedRequest': 'Approved request', 'issue.emergencyReason': 'Emergency reason',
  'issue.to': 'To', 'issue.fromStore': 'From store', 'issue.forElement': 'For element', 'issue.receiverSignOff': 'Receiver sign-off',
  'issue.differentGrade': 'Issue a different grade', 'issue.subReason': 'Substitution justification',
  'issue.emergencyBanner': 'Emergency · regularise within 24 h',
  'mr.saveLine': 'Save line', 'mr.changeMaterial': 'Change material', 'mr.element': 'Element', 'mr.addElement': 'Add another element',
  'mr.neededOnSite': 'Needed on site', 'mr.deliverStore': 'Deliver to store', 'mr.location': 'Delivery location on site',
  'mr.drawing': 'Drawing / detail reference', 'mr.purposeRemarks': 'Purpose / remarks', 'mr.requestType': 'Request type',
  'mr.materials': 'Materials', 'mr.fromElement': 'From element', 'mr.withinBoq': 'Within BoQ', 'mr.searchList': 'Search number or material',
  'mr.none': 'No requests yet', 'mr.noneBody': 'Raise a request for materials you need on site.',
  'progress.element': 'Element', 'progress.reportBtn': 'Report', 'progress.planned': 'Planned', 'progress.actual': 'Actual',
  'progress.activities': 'Activities', 'progress.photos': 'Progress photos (geotagged)', 'progress.issueOnSite': 'Issue on site?',
  'progress.reportDate': 'Report date', 'progress.qtyAchieved': 'Quantity achieved', 'progress.materialsPvI': 'Materials: planned vs issued',
  'progress.history': 'Progress history', 'progress.searchEl': 'Search element, e.g. C12', 'progress.verifyQueue': 'Verify queue',
  'progress.percent': 'Percent complete',
  // gate
  'gate.home': 'Gate', 'gate.scan': 'Scan gate pass', 'gate.scanHint': 'Check a vehicle out with the QR code',
  'gate.vehicle': 'Vehicle in / out', 'gate.vehicleHint': 'Log every vehicle at the gate', 'gate.passes': 'Gate passes',
  'gate.pendingExit': 'Pending exit', 'gate.onLoan': 'On loan', 'gate.overdue': 'Overdue return', 'gate.new': 'New gate pass',
  'gate.verify': 'Allow exit', 'gate.mismatch': 'Report mismatch', 'gate.plateSeen': 'Plate seen at gate',
  'gate.plateMatch': 'Plate matches', 'gate.plateDiff': 'Plate does not match the pass', 'gate.return': 'Record return',
  'gate.returnable': 'Returnable', 'gate.nonReturnable': 'Non-returnable', 'gate.expectedReturn': 'Expected return',
  'gate.destination': 'Destination', 'gate.purpose': 'Purpose', 'gate.direction': 'Direction', 'gate.in': 'In', 'gate.out': 'Out',
  'gate.loaded': 'Vehicle is loaded', 'gate.linkedDoc': 'Linked document', 'gate.logVehicle': 'Log vehicle',
  'gate.invalidQr': 'This QR code is not valid', 'gate.pointCamera': 'Point the camera at the QR code',
  'gate.submitPass': 'Submit for approval', 'gate.lines': 'Items leaving site',
  // settings
  'set.language': 'Language', 'set.calendar': 'Calendar', 'set.gregorian': 'Gregorian', 'set.ethiopian': 'Ethiopian',
  'set.telegram': 'Telegram', 'set.connectTelegram': 'Connect Telegram', 'set.telegramLinked': 'Connected as {u}',
  'set.telegramHint': 'Get approvals and alerts in Telegram.', 'set.notifications': 'Notifications', 'set.theme': 'Theme',
  'set.project': 'Project', 'set.preferences': 'Preferences', 'set.data': 'Data',
  // schedule progress + monthly tasks window (look-ahead)
  'sch.elements': 'Elements', 'sch.schedule': 'Schedule', 'sch.myTasks': 'My tasks', 'sch.mine': 'Mine', 'sch.all': 'All tasks',
  'sch.overdue': 'Overdue', 'sch.thisWeek': 'This week', 'sch.nextWeek': 'Next week', 'sch.critical': 'Critical', 'sch.milestone': 'Milestone',
  'sch.daysLate': '{n} d late', 'sch.verified': 'Verified {p}%', 'sch.reported': 'Reported {p}%', 'sch.plan': 'plan {p}%',
  'sch.toVerify': 'To verify', 'sch.fromElements': 'From elements', 'sch.noTasks': 'No tasks in this view',
  'sch.noTasksBody': 'Tasks appear here once the schedule is imported and synced.',
  'sch.noAssigned': 'Nothing is assigned to you in the look-ahead yet, so all tasks are shown.', 'sch.planned': 'Planned',
  'sch.forecast': 'Forecast', 'sch.update': 'Update progress', 'sch.report': 'Report', 'sch.percent': 'Percent complete',
  'sch.qtyToDate': 'Quantity done to date', 'sch.ofPlanned': 'of {q} {u}', 'sch.remaining': 'Remaining working days', 'sch.issue': 'Issue on site?',
  'sch.none': 'None', 'sch.issue.materials': 'Materials', 'sch.issue.labour': 'Labour', 'sch.issue.equipment': 'Equipment',
  'sch.issue.weather': 'Weather', 'sch.issue.drawing': 'Drawing', 'sch.issue.other': 'Other', 'sch.note': 'Note',
  'sch.promised': 'Done this week as promised?', 'sch.yes': 'Yes', 'sch.no': 'No', 'sch.saved': 'Progress saved on phone',
  'sch.elementLinked': 'This task takes its progress from its elements',
  'sch.elementLinkedBody': 'Report the element activities below. The task percent rolls up after the office verifies them.',
  'sch.loe': 'Level-of-effort task', 'sch.loeBody': 'This task earns with time and is not reported.', 'sch.summary': 'Summary task',
  'sch.steps': 'Steps done', 'sch.history': 'Reports',
  'sch.remarkNeeded': 'Add a note: the quantity is below the verified or above the planned quantity', 'sch.enterPct': 'Enter the percent complete',
  'sch.enterQty': 'Enter the quantity done to date', 'sch.chooseReason': 'Choose why it was not done',
  'sch.zeroHundred': 'Measured 0 / 100: report 0 or 100 (finished)', 'sch.startFinish': 'Measured start / finish', 'sch.notStarted': 'Not started',
  'sch.started': 'Started', 'sch.finished': 'Finished', 'sch.verifyTitle': 'Verify task progress', 'sch.verifyTasks': 'Schedule tasks',
  'sch.verifyElements': 'Element progress', 'sch.approve': 'Approve', 'sch.adjust': 'Adjust', 'sch.reject': 'Reject',
  'sch.verifiedPct': 'Verified percent', 'sch.verifiedQty': 'Verified quantity', 'sch.comment': 'Comment',
  'sch.commentHint': 'Required when you adjust or reject.', 'sch.commentNeeded': 'A comment is required when adjusting or rejecting',
  'sch.nothingToVerify': 'Nothing is waiting for verification.', 'sch.tasksToVerify': '{n} task report(s) to verify',
  'sch.tasksToVerifySub': 'Approve, adjust or reject', 'sch.overdueTasks': '{n} of your task(s) overdue',
  'sch.overdueSub': 'Update progress or the remaining days', 'sch.overview': 'Project progress', 'sch.pctPlanned': '% planned',
  'sch.pctComplete': '% complete', 'sch.onTrack': 'On track', 'sch.behind': 'Behind', 'sch.late': 'Late', 'sch.ahead': 'Ahead',
  'sch.noBand': 'Not measured yet', 'sch.statusDate': 'Status date {d}', 'sch.daysBehind': '{n} working days behind',
  'sch.daysAhead': '{n} working days ahead', 'sch.overviewOffline': 'Connect once to load the progress overview.', 'sch.lateTasks': '{n} late',
  'sch.criticalOpen': '{n} critical open', 'sch.planSentence': 'By today {p}% of the work should be done; {c}% is done and verified.',
  'la.title': 'Monthly tasks', 'la.month': 'Month', 'la.mine': 'Mine', 'la.week': 'Week {n}', 'la.continuing': 'Continuing ({n})',
  'la.until': 'until {d}', 'la.holiday': 'Public holiday', 'la.tentative': 'Tentative', 'la.noPlan': 'No look-ahead yet',
  'la.noPlanBody': 'The office engineer generates the monthly look-ahead; it appears here after sync.', 'la.draft': 'Draft · not published yet',
  'la.ppcThis': 'This week {d} of {n} done', 'la.ppcRolling': 'Plan reliability (4 weeks) {p}%', 'la.ppcNone': 'No closed weeks yet',
  'la.constraints': 'Constraints', 'la.addConstraint': 'Add constraint', 'la.clear': 'Clear', 'la.waive': 'Waive', 'la.block': 'Blocked',
  'la.owner': 'Owner', 'la.due': 'Due', 'la.waiveReason': 'Why can this constraint be waived?', 'la.clearComment': 'How was it cleared?',
  'la.noConstraints': 'No open constraints — ready to commit.', 'la.materials': 'Materials for this task', 'la.need': 'Need',
  'la.inStock': 'In stock', 'la.onOrder': 'On order', 'la.short': 'Short', 'la.needBy': 'Needed by {d}', 'la.requestStore': 'Request from store',
  'la.raisePr': 'Raise purchase request', 'la.needsOffline': 'Material needs load when online; showing the last copy.',
  'la.noNeeds': 'No linked materials for this task.', 'la.commitments': 'Weekly commitments', 'la.commitNext': 'Commit for next week',
  'la.commitThis': 'Commit for this week', 'la.override': 'Commit although not ready', 'la.overrideReason': 'Why commit although it is not ready?',
  'la.committed': 'Committed', 'la.notCommitted': 'Not committed', 'la.reportOutcome': 'Report outcome', 'la.completed': 'Completed',
  'la.notCompleted': 'Not completed', 'la.why': 'Why was it not completed?', 'la.commitSaved': 'Commitment saved on phone',
  'la.outcomeSaved': 'Outcome saved on phone', 'la.constraintSaved': 'Constraint saved on phone',
  'la.locked': 'Commitments for this week are locked', 'la.uncommitted': '{n} ready task(s) to commit for next week',
  'la.uncommittedSub': 'Weekly plan · commit what your crew will finish', 'la.constraintsMine': '{n} constraint(s) you own',
  'la.constraintsMineSub': 'Clear or update before the due date', 'la.description': 'Describe the constraint', 'la.type': 'Type',
  'la.responsible': 'Responsible', 'la.unassigned': 'Unassigned', 'la.targetPct': 'Target percent by week end', 'la.class': 'Class',
  'la.open': 'Open the task', 'la.window': '{s} – {f}', 'la.nextPlan': 'Next month', 'la.thisPlan': 'This month',
  'la.candidate': 'Rolled forward — confirm', 'la.pending': 'Pending',
} as const;

export type TKey = keyof typeof en;

const am: Partial<Record<TKey, string>> = {
  'tab.home': 'መነሻ', 'tab.issue': 'ወጪ', 'tab.requests': 'ጥያቄዎች', 'tab.approvals': 'ማጽደቂያ', 'tab.review': 'ግምገማ',
  'tab.stock': 'ክምችት', 'tab.progress': 'የሥራ ሂደት', 'tab.docs': 'ሰነዶች', 'tab.more': 'ተጨማሪ',
  'title.issueQueue': 'የወጪ ተራ', 'title.storeDocs': 'የመጋዘን ሰነዶች', 'title.settings': 'ቅንብሮች', 'title.search': 'ፍለጋ',
  'title.notifications': 'ማሳወቂያዎች', 'title.sync': 'የማመሳሰል ሁኔታ', 'title.alerts': 'ማንቂያዎች',
  'home.morning': 'እንደምን አደሩ', 'home.afternoon': 'እንደምን ዋሉ', 'home.evening': 'እንደምን አመሹ',
  'home.needsYou': 'እርስዎን የሚጠብቁ', 'home.seeAll': 'ሁሉንም ይመልከቱ ({n})', 'home.nothing': 'የሚጠብቅዎት ነገር የለም',
  'home.nothingBody': 'አዳዲስ ሥራዎች እንደደረሱ እዚህ ይታያሉ።', 'home.today': 'ዛሬ', 'home.quick': 'ፈጣን ተግባራት',
  'home.moreActions': 'ተጨማሪ ተግባራት', 'home.receive': 'ዕቃ መረከብ', 'home.receiveHint': 'ከፍተሻ ጋር የዕቃ ገቢ',
  'home.newRequest': 'አዲስ ጥያቄ', 'home.newRequestHint': 'ለሥራ ክፍሎችዎ የሚያስፈልጉ ዕቃዎች', 'home.lookahead': 'የቅድሚያ ዕቅድ ጥያቄ',
  'home.lookaheadHint': 'ለሚቀጥሉት ሳምንታት ዕቃዎችን ያቅዱ', 'home.criticalAlerts': '{n} አስቸኳይ ማንቂያ', 'home.criticalAlertsSub': 'እርምጃ የሚጠይቁ ክፍት ማንቂያዎች',
  'home.posToApprove': '{n} የግዢ ትዕዛዝ ለማጽደቅ', 'home.gateToApprove': '{n} የመውጫ ፈቃድ ለማጽደቅ',
  'home.expected': 'የሚጠበቁ ገቢዎች', 'home.delayed': '{n} የዘገዩ', 'home.syncRejected': '{n} ለውጥ በሰርቨሩ ተቀባይነት አላገኘም',
  'home.syncFix': 'ለማስተካከል ወይም ለመሰረዝ ይንኩ',
  'kpi.awaitingIssue': 'ወጪ የሚጠብቁ', 'kpi.lowStock': 'ዝቅተኛ ክምችት', 'kpi.due': 'የደረሱ / ያለፉ', 'kpi.transfersIn': 'ገቢ ዝውውሮች',
  'kpi.myOpen': 'ክፍት ጥያቄዎቼ', 'kpi.issuedToMe': 'ለእኔ ወጪ የሆኑ', 'kpi.activeElements': 'በሥራ ላይ ያሉ ክፍሎች',
  'kpi.delayedElements': 'የዘገዩ ክፍሎች', 'kpi.awaitingReview': 'ግምገማ የሚጠብቁ', 'kpi.toVerify': 'የሚረጋገጥ ሂደት',
  'kpi.boqAlerts': 'የBoQ ማንቂያዎች', 'kpi.overall': 'አጠቃላይ ሂደት', 'kpi.pendingApprovals': 'ማጽደቅ የሚጠብቁ',
  'kpi.shortages': 'አሳሳቢ እጥረቶች', 'kpi.toSource': 'የጸደቁ፣ የሚገዙ', 'kpi.lookahead14': 'የ14 ቀን ቅድመ ዕቅድ',
  'kpi.expected': 'የሚጠበቁ ገቢዎች', 'kpi.openPos': 'ክፍት የግዢ ትዕዛዞች', 'kpi.reorder': 'እንደገና የሚታዘዙ',
  'act.issue': 'ወጪ', 'act.return': 'ተመላሽ', 'act.count': 'ቆጠራ', 'act.wastage': 'ብክነት', 'act.transfer': 'ዝውውር',
  'act.more': 'ተጨማሪ…', 'act.updateProgress': 'ሂደት አዘምን', 'act.requests': 'ጥያቄዎች', 'act.signOff': 'ፊርማ',
  'act.stock': 'ክምችት', 'act.search': 'ፍለጋ', 'act.verifyProgress': 'ሂደት አረጋግጥ', 'act.elements': 'ክፍሎች',
  'act.documents': 'ሰነዶች', 'act.approvals': 'ማጽደቂያ', 'act.progress': 'ሂደት', 'act.stockReport': 'የክምችት ሪፖርት',
  'act.gatePass': 'የመውጫ ፈቃድ', 'act.alerts': 'ማንቂያዎች', 'act.purchaseOrders': 'የግዢ ትዕዛዞች', 'act.logPrice': 'ዋጋ መዝግብ',
  'act.reorder': 'እንደገና ማዘዝ', 'act.expected': 'የሚጠበቁ',
  'common.save': 'አስቀምጥ', 'common.cancel': 'ተው', 'common.approve': 'አጽድቅ', 'common.reject': 'ውድቅ አድርግ', 'common.submit': 'አስገባ',
  'common.done': 'ተጠናቋል', 'common.retry': 'እንደገና ሞክር', 'common.close': 'ዝጋ', 'common.acknowledge': 'ተቀብያለሁ', 'common.scan': 'ቃኝ',
  'common.search': 'ፈልግ', 'common.next': 'ቀጣይ', 'common.back': 'ተመለስ', 'common.addItem': 'ዕቃ ጨምር', 'common.remove': 'ዕቃ አስወግድ',
  'common.confirm': 'አረጋግጥ', 'common.settings': 'ቅንብሮች', 'common.signOut': 'ውጣ', 'common.optional': 'አማራጭ',
  'common.remarks': 'ማስታወሻ', 'common.items': 'ዕቃዎች', 'common.store': 'መጋዘን', 'common.supplier': 'አቅራቢ',
  'common.material': 'ዕቃ / ደረጃ', 'common.quantity': 'መጠን', 'common.plate': 'ሰሌዳ ቁጥር', 'common.driver': 'ሾፌር',
  'common.date': 'ቀን', 'common.status': 'ሁኔታ', 'common.all': 'ሁሉም', 'common.open': 'ክፍት', 'common.savedOnPhone': '{x} በስልኩ ተቀምጧል',
  'common.notOnPhone': 'እስካሁን በዚህ ስልክ ላይ የለም', 'common.allCaught': 'ሁሉም ተጠናቋል', 'common.never': 'በጭራሽ',
  'common.justNow': 'አሁን', 'common.minAgo': 'ከ{n} ደቂቃ በፊት', 'common.hAgo': 'ከ{n} ሰዓት በፊት', 'common.daysAgo': 'ከ{n} ቀን በፊት',
  'status.draft': 'ረቂቅ', 'status.submitted': 'ቀርቧል', 'status.reviewed': 'ተገምግሟል', 'status.returned': 'ተመልሷል',
  'status.approved': 'ጸድቋል', 'status.sourced': 'አቅራቢ ተገኝቷል', 'status.ordered': 'ታዟል', 'status.partially_issued': 'በከፊል ወጪ ሆኗል',
  'status.issued': 'ወጪ ሆኗል', 'status.closed': 'ተዘግቷል', 'status.rejected': 'ውድቅ ሆኗል', 'status.cancelled': 'ተሰርዟል',
  'status.pending_ack': 'ፊርማ በመጠባበቅ ላይ', 'status.acknowledged': 'ተረጋግጧል', 'status.posted': 'ተመዝግቧል',
  'status.reversed': 'ተቀልብሷል', 'status.in_transit': 'በጉዞ ላይ', 'status.received': 'ደርሷል', 'status.pending': 'በመጠባበቅ ላይ',
  'status.adjusted': 'ተስተካክሏል', 'status.reported': 'የሚረጋገጥ', 'status.verified': 'ተረጋግጧል', 'status.not_started': 'አልተጀመረም',
  'status.in_progress': 'በሂደት ላይ', 'status.completed': 'ተጠናቋል', 'status.on_hold': 'ተይዟል', 'status.hold_point': 'የፍተሻ ማቆሚያ',
  'status.exited': 'ከሳይት ወጥቷል', 'status.partially_returned': 'በከፊል ተመልሷል', 'status.sent': 'ለአቅራቢ ተልኳል',
  'status.partially_received': 'በከፊል ደርሷል', 'status.open': 'ክፍት', 'status.delayed': 'ዘግይቷል', 'status.overdue': 'ጊዜው አልፏል',
  'status.on_loan': 'በውሰት ላይ', 'status.critical': 'አስቸኳይ', 'status.warning': 'ማስጠንቀቂያ', 'status.info': 'መረጃ',
  'grn.title': 'ዕቃ መረከብ', 'grn.searchArriving': 'ጥያቄ፣ የግዢ ትዕዛዝ ወይም ዕቃ ይፈልጉ', 'grn.adhoc': 'ያለ ጥያቄ የመጣ ዕቃ',
  'grn.expectedMr': 'የሚጠበቁ · የጸደቁ፣ ሙሉ በሙሉ ያልደረሱ', 'grn.expectedPo': 'የግዢ ትዕዛዞች · ያልደረሱ',
  'grn.noneWaiting': 'የሚጠበቅ የጸደቀ ጥያቄ የለም', 'grn.noneWaitingBody': 'ያለ ጥያቄም ዕቃ መረከብ ይችላሉ።',
  'grn.post': 'GRN መዝግብ', 'grn.receivingStore': 'ተረካቢ መጋዘን', 'grn.dn': 'የማስረከቢያ ቁጥር', 'grn.received': 'ተረክቧል',
  'grn.receiveAnother': 'ሌላ ተረከብ', 'grn.stockUpdated': 'ክምችቱ አሁን ተዘምኗል። በራሱ ይመሳሰላል።',
  'grn.allOk': 'ሁሉም ደህና', 'grn.short': 'ያነሰ', 'grn.damaged': 'የተበላሸ', 'grn.photos': 'የማስረከቢያ ሰነድ እና ፎቶዎች',
  'grn.signature': 'የአቅራቢ / የሾፌር ፊርማ', 'grn.againstPo': 'በ{po} መሠረት', 'grn.ordered': 'የታዘዘ {q}', 'grn.due': 'የቀረ {q}',
  'issue.title': 'ዕቃ ወጪ ማድረግ', 'issue.post': 'ወጪ መዝግብ', 'issue.issuedTo': 'የተረከበው', 'issue.element': 'የግንባታ ክፍል',
  'issue.emergency': 'አስቸኳይ ወጪ (ያለ ጥያቄ)', 'issue.receiverSig': 'የተረካቢ ፊርማ',
  'mr.new': 'አዲስ ጥያቄ', 'mr.submit': 'ጥያቄ አስገባ', 'mr.saveDraft': 'ረቂቅ አስቀምጥ', 'mr.requiredDate': 'የሚያስፈልግበት ቀን',
  'mr.block': 'ብሎክ', 'mr.priority': 'ቅድሚያ', 'mr.purpose': 'ዓላማ', 'mr.addMaterial': 'ዕቃ ጨምር',
  'progress.title': 'ክፍሎች እና የሥራ ሂደት', 'progress.report': 'ሂደት ሪፖርት አድርግ', 'progress.verify': 'ሂደት አረጋግጥ',
  'progress.save': 'ሂደት አስቀምጥ', 'progress.pct': 'የተጠናቀቀ (%)',
  'issue.issued': 'ወጪ ሆኗል', 'issue.approvedRequest': 'የጸደቀ ጥያቄ', 'issue.emergencyReason': 'የአስቸኳይ ምክንያት',
  'issue.to': 'ለ', 'issue.fromStore': 'ከመጋዘን', 'issue.forElement': 'ለግንባታ ክፍል', 'issue.receiverSignOff': 'የተረካቢ ማረጋገጫ',
  'issue.differentGrade': 'ሌላ ደረጃ ወጪ አድርግ', 'issue.subReason': 'የመተኪያ ምክንያት',
  'issue.emergencyBanner': 'አስቸኳይ · በ24 ሰዓት ውስጥ መስተካከል አለበት',
  'mr.saveLine': 'መስመር አስቀምጥ', 'mr.changeMaterial': 'ዕቃ ቀይር', 'mr.element': 'የግንባታ ክፍል', 'mr.addElement': 'ሌላ ክፍል ጨምር',
  'mr.neededOnSite': 'በሳይት የሚያስፈልግበት ቀን', 'mr.deliverStore': 'የሚረከበው መጋዘን', 'mr.location': 'በሳይት የማስረከቢያ ቦታ',
  'mr.drawing': 'የንድፍ / ዝርዝር ማጣቀሻ', 'mr.purposeRemarks': 'ዓላማ / ማስታወሻ', 'mr.requestType': 'የጥያቄ ዓይነት',
  'mr.materials': 'ዕቃዎች', 'mr.fromElement': 'ከክፍሉ መጠን', 'mr.withinBoq': 'በBoQ ውስጥ', 'mr.searchList': 'ቁጥር ወይም ዕቃ ይፈልጉ',
  'mr.none': 'እስካሁን ጥያቄ የለም', 'mr.noneBody': 'በሳይት ለሚያስፈልጉ ዕቃዎች ጥያቄ ያቅርቡ።',
  'progress.element': 'የግንባታ ክፍል', 'progress.reportBtn': 'ሪፖርት አድርግ', 'progress.planned': 'የታቀደ', 'progress.actual': 'ትክክለኛ',
  'progress.activities': 'ተግባራት', 'progress.photos': 'የሂደት ፎቶዎች (ከቦታ መረጃ ጋር)', 'progress.issueOnSite': 'በሳይት ችግር አለ?',
  'progress.reportDate': 'የሪፖርት ቀን', 'progress.qtyAchieved': 'የተሠራ መጠን', 'progress.materialsPvI': 'ዕቃዎች፦ የታቀደ እና ወጪ የሆነ',
  'progress.history': 'የሂደት ታሪክ', 'progress.searchEl': 'ክፍል ይፈልጉ፣ ለምሳሌ C12', 'progress.verifyQueue': 'የማረጋገጫ ተራ',
  'progress.percent': 'የተጠናቀቀ መቶኛ',
  'gate.home': 'በር', 'gate.scan': 'የመውጫ ፈቃድ ቃኝ', 'gate.scanHint': 'ተሽከርካሪን በQR ኮድ ያስወጡ',
  'gate.vehicle': 'ተሽከርካሪ ገቢ / ወጪ', 'gate.vehicleHint': 'በበሩ የሚያልፍ እያንዳንዱን ተሽከርካሪ ይመዝግቡ', 'gate.passes': 'የመውጫ ፈቃዶች',
  'gate.pendingExit': 'መውጫ የሚጠብቁ', 'gate.onLoan': 'በውሰት ላይ', 'gate.overdue': 'የመመለሻ ጊዜ ያለፈ', 'gate.new': 'አዲስ የመውጫ ፈቃድ',
  'gate.verify': 'መውጣት ፍቀድ', 'gate.mismatch': 'አለመመሳሰል ሪፖርት አድርግ', 'gate.plateSeen': 'በበሩ የታየ ሰሌዳ',
  'gate.plateMatch': 'ሰሌዳው ይመሳሰላል', 'gate.plateDiff': 'ሰሌዳው ከፈቃዱ ጋር አይመሳሰልም', 'gate.return': 'ተመላሽ መዝግብ',
  'gate.returnable': 'ተመላሽ', 'gate.nonReturnable': 'የማይመለስ', 'gate.expectedReturn': 'የሚመለስበት ቀን',
  'gate.destination': 'መድረሻ', 'gate.purpose': 'ዓላማ', 'gate.direction': 'አቅጣጫ', 'gate.in': 'ገቢ', 'gate.out': 'ወጪ',
  'gate.loaded': 'ተሽከርካሪው ጭነት አለው', 'gate.linkedDoc': 'የተያያዘ ሰነድ', 'gate.logVehicle': 'ተሽከርካሪ መዝግብ',
  'gate.invalidQr': 'ይህ QR ኮድ ትክክል አይደለም', 'gate.pointCamera': 'ካሜራውን ወደ QR ኮዱ ያቅርቡ',
  'gate.submitPass': 'ለማጽደቅ አስገባ', 'gate.lines': 'ከሳይት የሚወጡ ዕቃዎች',
  'set.language': 'ቋንቋ', 'set.calendar': 'የቀን አቆጣጠር', 'set.gregorian': 'ግሪጎሪያን', 'set.ethiopian': 'ኢትዮጵያዊ',
  'set.telegram': 'ቴሌግራም', 'set.connectTelegram': 'ቴሌግራም አገናኝ', 'set.telegramLinked': 'እንደ {u} ተገናኝቷል',
  'set.telegramHint': 'ማጽደቂያዎችንና ማንቂያዎችን በቴሌግራም ያግኙ።', 'set.notifications': 'ማሳወቂያዎች', 'set.theme': 'ገጽታ',
  'set.project': 'ፕሮጀክት', 'set.preferences': 'ምርጫዎች', 'set.data': 'ዳታ',
  // schedule progress + monthly tasks window (look-ahead)
  'sch.elements': 'መዋቅር ክፍሎች', 'sch.schedule': 'የሥራ መርሐ ግብር', 'sch.myTasks': 'የእኔ ሥራዎች', 'sch.mine': 'የእኔ', 'sch.all': 'ሁሉም ሥራዎች',
  'sch.overdue': 'ጊዜው ያለፈ', 'sch.thisWeek': 'በዚህ ሳምንት', 'sch.nextWeek': 'በሚቀጥለው ሳምንት', 'sch.critical': 'ወሳኝ', 'sch.milestone': 'ምዕራፍ',
  'sch.daysLate': '{n} ቀን ዘግይቷል', 'sch.verified': 'የተረጋገጠ {p}%', 'sch.reported': 'ሪፖርት የተደረገ {p}%', 'sch.plan': 'ዕቅድ {p}%',
  'sch.toVerify': 'ማረጋገጫ የሚጠብቅ', 'sch.fromElements': 'ከመዋቅር ክፍሎች', 'sch.noTasks': 'በዚህ እይታ ሥራ የለም',
  'sch.noTasksBody': 'መርሐ ግብሩ ከገባና ከተመሳሰለ በኋላ ሥራዎች እዚህ ይታያሉ።', 'sch.noAssigned': 'በቅድመ ዕቅዱ እስካሁን የተመደበልዎ ሥራ ስለሌለ ሁሉም ሥራዎች ይታያሉ።',
  'sch.planned': 'የታቀደ', 'sch.forecast': 'የሚጠበቅ', 'sch.update': 'እድገት አዘምን', 'sch.report': 'ሪፖርት አድርግ', 'sch.percent': 'የተጠናቀቀ መቶኛ',
  'sch.qtyToDate': 'እስከ ዛሬ የተሰራ መጠን', 'sch.ofPlanned': 'ከ{q} {u}', 'sch.remaining': 'የቀሩ የሥራ ቀናት', 'sch.issue': 'በሳይት ችግር አለ?', 'sch.none': 'የለም',
  'sch.issue.materials': 'ግብዓት', 'sch.issue.labour': 'የሰው ኃይል', 'sch.issue.equipment': 'መሣሪያ', 'sch.issue.weather': 'የአየር ሁኔታ',
  'sch.issue.drawing': 'ስዕል', 'sch.issue.other': 'ሌላ', 'sch.note': 'ማስታወሻ', 'sch.promised': 'በዚህ ሳምንት ቃል እንደተገባው ተጠናቋል?', 'sch.yes': 'አዎ',
  'sch.no': 'አይ', 'sch.saved': 'እድገቱ በስልኩ ተቀምጧል', 'sch.elementLinked': 'ይህ ሥራ እድገቱን ከመዋቅር ክፍሎቹ ይወስዳል',
  'sch.elementLinkedBody': 'ከታች ያሉትን የመዋቅር ክፍል ሥራዎች ሪፖርት ያድርጉ። ቢሮው ካረጋገጠ በኋላ የሥራው መቶኛ ይሰላል።', 'sch.loe': 'በጊዜ የሚታሰብ ሥራ',
  'sch.loeBody': 'ይህ ሥራ በጊዜ ይሰላል፤ ሪፖርት አይደረግም።', 'sch.summary': 'ማጠቃለያ ሥራ', 'sch.steps': 'የተጠናቀቁ ደረጃዎች', 'sch.history': 'ሪፖርቶች',
  'sch.remarkNeeded': 'ማስታወሻ ያክሉ፦ መጠኑ ከተረጋገጠው ያነሰ ወይም ከታቀደው በላይ ነው', 'sch.enterPct': 'የተጠናቀቀውን መቶኛ ያስገቡ', 'sch.enterQty': 'እስከ ዛሬ የተሰራውን መጠን ያስገቡ',
  'sch.chooseReason': 'ያልተጠናቀቀበትን ምክንያት ይምረጡ', 'sch.zeroHundred': 'በ0 / 100 ይለካል፦ 0 ወይም 100 (ተጠናቋል) ሪፖርት ያድርጉ',
  'sch.startFinish': 'በጅምር / ማጠናቀቅ ይለካል', 'sch.notStarted': 'አልተጀመረም', 'sch.started': 'ተጀምሯል', 'sch.finished': 'ተጠናቋል',
  'sch.verifyTitle': 'የሥራ እድገት አረጋግጥ', 'sch.verifyTasks': 'የመርሐ ግብር ሥራዎች', 'sch.verifyElements': 'የመዋቅር ክፍል እድገት', 'sch.approve': 'አጽድቅ',
  'sch.adjust': 'አስተካክል', 'sch.reject': 'ውድቅ አድርግ', 'sch.verifiedPct': 'የተረጋገጠ መቶኛ', 'sch.verifiedQty': 'የተረጋገጠ መጠን', 'sch.comment': 'አስተያየት',
  'sch.commentHint': 'ሲያስተካክሉ ወይም ውድቅ ሲያደርጉ ያስፈልጋል።', 'sch.commentNeeded': 'ሲያስተካክሉ ወይም ውድቅ ሲያደርጉ አስተያየት ያስፈልጋል',
  'sch.nothingToVerify': 'ማረጋገጫ የሚጠብቅ ነገር የለም።', 'sch.tasksToVerify': 'ለማረጋገጥ {n} የሥራ ሪፖርት(ዎች)', 'sch.tasksToVerifySub': 'አጽድቅ፣ አስተካክል ወይም ውድቅ አድርግ',
  'sch.overdueTasks': 'ጊዜያቸው ያለፈ {n} ሥራ(ዎች)', 'sch.overdueSub': 'እድገቱን ወይም የቀሩትን ቀናት ያዘምኑ', 'sch.overview': 'የፕሮጀክት እድገት',
  'sch.pctPlanned': 'የታቀደ %', 'sch.pctComplete': 'የተጠናቀቀ %', 'sch.onTrack': 'በዕቅዱ መሠረት', 'sch.behind': 'ወደኋላ የቀረ', 'sch.late': 'በጣም የዘገየ',
  'sch.ahead': 'ቀድሞ የሄደ', 'sch.noBand': 'ገና አልተለካም', 'sch.statusDate': 'የሪፖርት ቀን {d}', 'sch.daysBehind': '{n} የሥራ ቀን ወደኋላ',
  'sch.daysAhead': '{n} የሥራ ቀን ቀድሞ', 'sch.overviewOffline': 'የእድገት ማጠቃለያውን ለመጫን አንድ ጊዜ ከኢንተርኔት ጋር ይገናኙ።', 'sch.lateTasks': '{n} የዘገዩ',
  'sch.criticalOpen': '{n} ወሳኝ ክፍት', 'sch.planSentence': 'እስከ ዛሬ {p}% ሥራ መጠናቀቅ ነበረበት፤ {c}% ተጠናቅቆ ተረጋግጧል።', 'la.title': 'የወሩ ሥራዎች', 'la.month': 'ወር',
  'la.mine': 'የእኔ', 'la.week': 'ሳምንት {n}', 'la.continuing': 'የሚቀጥሉ ({n})', 'la.until': 'እስከ {d}', 'la.holiday': 'ሕዝባዊ በዓል',
  'la.tentative': 'ያልተረጋገጠ', 'la.noPlan': 'ገና ቅድመ ዕቅድ የለም', 'la.noPlanBody': 'የቢሮ መሐንዲሱ የወሩን ቅድመ ዕቅድ ያዘጋጃል፤ ከተመሳሰለ በኋላ እዚህ ይታያል።',
  'la.draft': 'ረቂቅ · ገና አልታተመም', 'la.ppcThis': 'በዚህ ሳምንት ከ{n} {d} ተጠናቋል', 'la.ppcRolling': 'የዕቅድ አፈጻጸም (4 ሳምንት) {p}%',
  'la.ppcNone': 'ገና የተዘጋ ሳምንት የለም', 'la.constraints': 'እንቅፋቶች', 'la.addConstraint': 'እንቅፋት ጨምር', 'la.clear': 'ተፈቷል', 'la.waive': 'እለፍ',
  'la.block': 'ታግዷል', 'la.owner': 'ኃላፊ', 'la.due': 'የመጨረሻ ቀን', 'la.waiveReason': 'ይህ እንቅፋት ለምን ይታለፋል?', 'la.clearComment': 'እንዴት ተፈታ?',
  'la.noConstraints': 'ክፍት እንቅፋት የለም — ቃል ለመግባት ዝግጁ ነው።', 'la.materials': 'ለዚህ ሥራ የሚያስፈልጉ ግብዓቶች', 'la.need': 'የሚያስፈልግ', 'la.inStock': 'በመጋዘን ያለ',
  'la.onOrder': 'የታዘዘ', 'la.short': 'የጎደለ', 'la.needBy': 'እስከ {d} ያስፈልጋል', 'la.requestStore': 'ከመጋዘን ጠይቅ', 'la.raisePr': 'የግዥ ጥያቄ አቅርብ',
  'la.needsOffline': 'የግብዓት ፍላጎቱ በኢንተርኔት ይጫናል፤ የመጨረሻው ቅጂ ይታያል።', 'la.noNeeds': 'ለዚህ ሥራ የተያያዘ ግብዓት የለም።', 'la.commitments': 'ሳምንታዊ ቃል ኪዳኖች',
  'la.commitNext': 'ለሚቀጥለው ሳምንት ቃል ግባ', 'la.commitThis': 'ለዚህ ሳምንት ቃል ግባ', 'la.override': 'ዝግጁ ባይሆንም ቃል ግባ',
  'la.overrideReason': 'ዝግጁ ባይሆንም ለምን ቃል ይገባሉ?', 'la.committed': 'ቃል ተገብቷል', 'la.notCommitted': 'ቃል አልተገባም', 'la.reportOutcome': 'ውጤቱን ሪፖርት አድርግ',
  'la.completed': 'ተጠናቋል', 'la.notCompleted': 'አልተጠናቀቀም', 'la.why': 'ለምን አልተጠናቀቀም?', 'la.commitSaved': 'ቃል ኪዳኑ በስልኩ ተቀምጧል',
  'la.outcomeSaved': 'ውጤቱ በስልኩ ተቀምጧል', 'la.constraintSaved': 'እንቅፋቱ በስልኩ ተቀምጧል', 'la.locked': 'የዚህ ሳምንት ቃል ኪዳኖች ተቆልፈዋል',
  'la.uncommitted': 'ለሚቀጥለው ሳምንት ቃል የሚገባባቸው {n} ዝግጁ ሥራ(ዎች)', 'la.uncommittedSub': 'ሳምንታዊ ዕቅድ · ቡድንዎ የሚጨርሰውን ቃል ይግቡ',
  'la.constraintsMine': 'እርስዎ ኃላፊ የሆኑባቸው {n} እንቅፋት(ዎች)', 'la.constraintsMineSub': 'ከመጨረሻው ቀን በፊት ይፍቱ ወይም ያዘምኑ', 'la.description': 'እንቅፋቱን ይግለጹ',
  'la.type': 'ዓይነት', 'la.responsible': 'ኃላፊ', 'la.unassigned': 'ያልተመደበ', 'la.targetPct': 'በሳምንቱ መጨረሻ የታቀደ መቶኛ', 'la.class': 'ምድብ',
  'la.open': 'ሥራውን ክፈት', 'la.window': '{s} – {f}', 'la.nextPlan': 'የሚቀጥለው ወር', 'la.thisPlan': 'ይህ ወር', 'la.candidate': 'ወደፊት የተላለፈ — ያረጋግጡ',
  'la.pending': 'በመጠባበቅ ላይ',
};

const DICT: Record<Locale, Partial<Record<TKey, string>>> = { en, am };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let prefs: LocalePrefs = { locale: 'en', calendar: 'gregorian' };
let loaded = false;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const getPrefs = () => prefs;

/** Reads persisted prefs once the local DB is open. Safe to call repeatedly. */
export function loadLocalePrefs() {
  if (loaded) return;
  try {
    const l = kvGet('ui:locale');
    const c = kvGet('ui:calendar');
    prefs = { locale: l === 'am' ? 'am' : 'en', calendar: c === 'ethiopian' ? 'ethiopian' : 'gregorian' };
    loaded = true;
    listeners.forEach((x) => x());
  } catch {
    // DB not open yet.
  }
}

/** True once the user (or the server profile) has chosen a locale on this device. */
export const hasLocalLocale = () => { try { return kvGet('ui:locale') != null; } catch { return false; } };

export function setLocalePrefs(patch: Partial<LocalePrefs>) {
  prefs = { ...prefs, ...patch };
  try {
    kvSet('ui:locale', prefs.locale);
    kvSet('ui:calendar', prefs.calendar);
  } catch { /* not open */ }
  listeners.forEach((x) => x());
  try { bump(); } catch { /* not open */ } // every useData screen re-renders (dates, labels)
}

export const getLocale = (): Locale => prefs.locale;
export const getCalendar = (): Calendar => prefs.calendar;

/** Subscribe a component to language / calendar changes. */
export function useLocale(): LocalePrefs {
  return useSyncExternalStore(subscribe, getPrefs);
}

// ---------------------------------------------------------------------------
// Translate
// ---------------------------------------------------------------------------

function fill(s: string, vars?: Record<string, string | number>) {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] != null ? String(vars[k]) : m));
}

/** Translate a key (falls back to English). */
export function t(key: TKey, vars?: Record<string, string | number>): string {
  return fill(DICT[prefs.locale][key] ?? en[key], vars);
}

/** Translate a dynamic key such as `status.${s}`; returns `fallback` when the key is unknown. */
export function tx(key: string, fallback: string, vars?: Record<string, string | number>): string {
  const d = DICT[prefs.locale] as Record<string, string | undefined>;
  const e = en as Record<string, string | undefined>;
  return fill(d[key] ?? e[key] ?? fallback, vars);
}

/** Hook form: re-renders on language change and returns the translator. */
export function useT(): typeof t {
  useLocale();
  return t;
}

/** Feature modules add their own keys (en + am) at load time, e.g. lib/flows-i18n.ts; read them with tx(). */
export function registerStrings(locale: Locale, strings: Record<string, string>) {
  Object.assign(DICT[locale] as Record<string, string>, strings);
}
