import { invoke, listen, openUrl } from './lib/platform';

import {
  clearAuthCallbackUrl,
  completePasswordReset as completeSupabasePasswordReset,
  getAuthCallbackError,
  getSession as getSupabaseSession,
  handleAuthCallbackUrl,
  isAuthConfigured,
  isAuthCallbackRoute,
  onAuthStateChange as onSupabaseAuthStateChange,
  resetPassword as resetSupabasePassword,
  resendSignUpCode,
  signIn as signInWithSupabase,
  signOut as signOutFromSupabase,
  signUp as signUpWithSupabase,
  verifyEmailCode,
} from './lib/auth';
import {
  canCreateBooking as canCreateBookingForBilling,
  canCreateCustomer as canCreateCustomerForBilling,
  canCheckVrm as canCheckVrmForBilling,
  canCreateJobCard as canCreateJobCardForBilling,
  canCreateVehicle as canCreateVehicleForBilling,
  canSendSms as canSendSmsForBilling,
  checkVehicleUsage,
  createBillingPortalSession,
  createCheckoutSession,
  getCurrentMonthKey,
  incrementVehicleUsage,
  invalidateBillingSnapshot,
  loadBillingSnapshot,
  syncBillingStatus as syncBillingStatusFromStripe,
  syncCheckoutSession,
} from './lib/billing';
import { useAdminAuth } from './hooks/useAdminAuth';
import { fetchAdminDashboardStats } from './services/adminStats';
import {
  createAdminReferralCode,
  fetchAdminReferrals,
  markAdminReferralCommissionPaid as markAdminReferralCommissionPaidService,
  updateAdminReferralCode,
} from './services/adminReferrals';
import { normalizeAdminSection, renderAdminDashboardPage } from './pages/admin/AdminDashboard';

// ── STATE ──────────────────────────────────────────────────────────────────
let state = {
  screen: 'dashboard',
  clients: [], vehicles: [], jobs: [], invoices: [], bookings: [], workers: [],
  inventoryItems: [], inventoryMovements: [], messageLog: [],
  selectedClient: null, selectedJob: null, selectedInvoice: null,
  jobLines: [], invoiceLines: [], allJobLines: [],
  invoiceEditorId: null,
  invoiceEditorScrollTop: 0,
  invoiceEditorDirty: false,
  invoiceEditorCloudSaving: false,
  invoiceCreateDraft: null,
  modalState: null,
  userInteractionSerial: 0,
  pendingFocusId: null,
  pendingFocusSelectAll: false,
  pendingFocusSerial: 0,
  calendarWeekOffset: 0,
  calendarViewMode: 'week',
  bookingDraft: null,
  searchQuery: '',
  clientStatusFilter: 'all',
  clientVehicleFilter: 'all',
  clientLastVisitFilter: 'any',
  inventoryFilter: 'all',
  jobStatusFilter: 'active',
  jobLineSort: {
    field: '',
    direction: 'asc',
  },
  dashboardDateFilter: 'month',
  reportsDateFilter: 'this-month',
  reportsCustomFrom: '',
  reportsCustomTo: '',
  reportsSection: 'overview',
  workerEditId: null,
  messageFilter: 'all',
  messageQuickFilter: 'all',
  messageSettings: null,
  billingSnapshot: null,
  billingNotice: null,
  billingPendingCheckout: null,
  billingReferralCode: '',
  adminAccess: {
    userId: '',
    checked: false,
    isAdmin: false,
    loading: false,
    error: '',
    profile: null,
  },
  adminSection: 'dashboard',
  adminStats: {
    loading: false,
    error: '',
    data: null,
  },
  adminReferrals: {
    loading: false,
    error: '',
    data: null,
  },
  adminReferralEditId: '',
  adminReferralSaving: false,
  settingsCategory: 'garage',
  autoSmsReminderRunKey: '',
  sorts: {},
  navOrder: [],
  cloud: {
    configured: false,
    account_email: '',
    user_id: '',
    access_token: '',
    refresh_token: '',
    last_synced_at: '',
  },
  cloudForm: {
    mode: 'login',
    garageName: '',
    email: '',
    password: '',
    confirmPassword: '',
    verificationCode: '',
    loading: false,
    error: '',
    success: '',
    notice: '',
    noticeTone: 'blue',
  },
  settings: {
    garage_name: 'Garage CRM',
    garage_address: '',
    garage_phone: '',
    garage_email: '',
    garage_website: '',
    vat_number: '',
    company_number: '',
    bank_details: '',
    payment_terms: '',
    language: 'en',
    distance_unit: 'mi',
    currency: 'GBP',
    vat_enabled: true,
    default_vat_rate: 20,
    booking_slot_interval: 60,
    allow_past_booking_times: false,
    inventory_enabled: false,
  },
  appUpdate: {
    currentVersion: '',
    configured: false,
    checking: false,
    installing: false,
    availableVersion: '',
    availableNotes: '',
    availableDate: '',
    checkedAt: '',
    notice: '',
    noticeTone: 'blue',
  },
  cloudHydratedUserId: '',
  cloudBootstrapping: false,
  garageSetupMode: false,
  mobileNavOpen: false,
};

const BOOKING_TIMES = ['08:00','08:30','09:00','09:30','10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30','14:00','14:30','15:00','15:30','16:00','16:30','17:00'];
const BOOKING_SERVICE_TYPES = ['Full Service', 'Interim Service', 'MOT', 'Diagnostics', 'Repair'];
const BRAND_ICON_SRC = './brand/icon.png';
const BRAND_LOGO_SRC = './brand/logo.png';
const UNKNOWN_CUSTOMER_NAME = 'Unknown customer';
const UNKNOWN_CUSTOMER_NOTES = 'System placeholder for vehicles where the customer name and phone are not known yet.';
const UNKNOWN_CUSTOMER_NAME_PATTERN = /^unknown customer(?:\s*#\d+)?$/i;
const CLOUD_REMOTE_REFRESH_INTERVAL_MS = 5 * 60_000;
const CLOUD_REMOTE_REFRESH_THROTTLE_MS = 60_000;
let cloudRemoteRefreshInFlight = null;
let cloudLastRemoteCheckAt = 0;
let cloudHasUnsyncedLocalChanges = false;
const DEFAULT_SETTINGS = Object.freeze({
  garage_name: 'Garage CRM',
  garage_address: '',
  garage_phone: '',
  garage_email: '',
  garage_website: '',
  vat_number: '',
  company_number: '',
  bank_details: '',
  payment_terms: '',
  language: 'en',
  distance_unit: 'mi',
  currency: 'GBP',
  vat_enabled: true,
  default_vat_rate: 20,
  booking_slot_interval: 60,
  allow_past_booking_times: false,
  inventory_enabled: false,
});
const LANGUAGE_OPTIONS = Object.freeze([
  { value: 'en', label: 'English' },
  { value: 'ru', label: 'Русский' },
  { value: 'bg', label: 'Български' },
]);
const UI_TRANSLATIONS = Object.freeze({
  ru: {
    'Dashboard': 'Панель',
    'Customers': 'Клиенты',
    'Vehicles': 'Автомобили',
    'Job Cards': 'Заказы',
    'Invoices': 'Счета',
    'Reports': 'Отчёты',
    'Inventory': 'Склад',
    'Calendar': 'Календарь',
    'Messages': 'Сообщения',
    'Settings': 'Настройки',
    'Garage': 'Гараж',
    'Bookings': 'Записи',
    'Billing': 'Оплата',
    'Account': 'Аккаунт',
    'System': 'Система',
    'Workspace': 'Рабочая область',
    'Garage setup': 'Настройка гаража',
    'Active': 'Активно',
    'Locked': 'Заблокировано',
    'Garage name': 'Название гаража',
    'Business address': 'Адрес бизнеса',
    'Garage phone': 'Телефон гаража',
    'Garage email': 'Email гаража',
    'Website': 'Сайт',
    'Company number': 'Номер компании',
    'Language': 'Язык',
    'Distance unit': 'Единица расстояния',
    'Currency': 'Валюта',
    'Miles (mi)': 'Мили (mi)',
    'Kilometres (km)': 'Километры (km)',
    '1 hour': '1 час',
    '30 minutes': '30 минут',
    'VAT': 'VAT',
    'Default VAT rate (%)': 'Ставка VAT по умолчанию (%)',
    'VAT number': 'VAT номер',
    'Payment terms': 'Условия оплаты',
    'Bank details': 'Банковские реквизиты',
    'Save and open Dashboard': 'Сохранить и открыть панель',
    'Save changes': 'Сохранить изменения',
    'Discard': 'Отменить',
    'Calendar slot size': 'Размер слота календаря',
    'Allow same-day past times': 'Разрешить прошедшее время сегодня',
    'Save booking settings': 'Сохранить настройки записей',
    'Open calendar': 'Открыть календарь',
    'Use inventory on job lines': 'Использовать склад в строках заказа',
    'Save inventory settings': 'Сохранить настройки склада',
    'Open inventory': 'Открыть склад',
    'On': 'Вкл',
    'Off': 'Выкл',
    'Enabled': 'Включено',
    'Disabled': 'Отключено',
    'Login': 'Вход',
    'Logged in': 'Выполнен вход',
    'Sign out': 'Выйти',
    'Login to cloud': 'Войти в облако',
    'Create account': 'Создать аккаунт',
    'Email': 'Email',
    'Password': 'Пароль',
    'Back to login': 'Назад ко входу',
    'Verify email': 'Подтвердить email',
    'Resend code': 'Отправить код снова',
    'Save new password': 'Сохранить новый пароль',
    'Forgot password?': 'Забыли пароль?',
    'Back up now': 'Создать копию сейчас',
    'Restore from cloud': 'Восстановить из облака',
    'Check': 'Проверить',
    'Check for update': 'Проверить обновление',
    'Install update': 'Установить обновление',
    'Current version': 'Текущая версия',
    'Update available': 'Доступно обновление',
    'Ready': 'Готово',
    'New': 'Новый',
    'Diagnosing': 'Диагностика',
    'Waiting Parts': 'Ожидание деталей',
    'In Progress': 'В работе',
    'Completed': 'Завершено',
    'Cancelled': 'Отменено',
    'Unpaid': 'Не оплачено',
    'Partial': 'Частично',
    'Paid': 'Оплачено',
    'Draft': 'Черновик',
    'Failed': 'Ошибка',
    'Sent': 'Отправлено',
    'Pending': 'Ожидает',
    'Confirmed': 'Подтверждено',
    'Customer': 'Клиент',
    'Owner': 'Владелец',
    'Vehicle': 'Автомобиль',
    'Vehicle *': 'Автомобиль *',
    'Customer *': 'Клиент *',
    'Status': 'Статус',
    'Actions': 'Действия',
    'Cancel': 'Отмена',
    'Save': 'Сохранить',
    'Delete': 'Удалить',
    'Edit': 'Редактировать',
    'Add': 'Добавить',
    'Create': 'Создать',
    'Search': 'Поиск',
    'Details': 'Детали',
    'Notes': 'Заметки',
    'No notes recorded.': 'Заметок нет.',
    'Subtotal': 'Подытог',
    'Total': 'Итого',
    'Deposit paid': 'Оплаченный депозит',
    'Balance due': 'Остаток к оплате',
    'Amount due': 'Сумма к оплате',
    'Issued': 'Выставлен',
    'Due': 'Срок',
    'Due soon': 'Скоро срок',
    'Overdue': 'Просрочено',
    'No due date': 'Нет даты срока',
    'No MOT date': 'Нет даты MOT',
    'No service date': 'Нет даты сервиса',
    'Registration': 'Регистрация',
    'Registration *': 'Регистрация *',
    'Make': 'Марка',
    'Model': 'Модель',
    'Model (optional)': 'Модель (необязательно)',
    'Make / Model': 'Марка / модель',
    'VIN': 'VIN',
    'Year': 'Год',
    'Engine': 'Двигатель',
    'Fuel': 'Топливо',
    'Fuel type': 'Тип топлива',
    'Colour': 'Цвет',
    'Mileage': 'Пробег',
    'Mileage in': 'Пробег при приёме',
    'MOT due': 'MOT до',
    'Service due': 'Сервис до',
    'Unknown customer': 'Неизвестный клиент',
    'Unknown customer / walk-in': 'Неизвестный клиент / без записи',
    'No owner': 'Нет владельца',
    'No mileage': 'Нет пробега',
    'No engine details': 'Нет данных двигателя',
    'No active job': 'Нет активного заказа',
    'No vehicles found': 'Автомобили не найдены',
    'No customers match this search': 'Клиенты не найдены',
    'No vehicles match this search': 'Автомобили не найдены',
    'New Vehicle': 'Новый автомобиль',
    'Edit Vehicle': 'Редактировать автомобиль',
    'Add vehicle': 'Добавить автомобиль',
    '+ Add vehicle': '+ Добавить автомобиль',
    'Check DVLA': 'Проверить DVLA',
    'Send SMS': 'Отправить SMS',
    'Send MOT reminder': 'Отправить напоминание MOT',
    'Send service reminder': 'Отправить напоминание о сервисе',
    'SMS history': 'История SMS',
    'Job': 'Заказ',
    'Job card': 'Заказ',
    'Job card *': 'Заказ *',
    'New Job Card': 'Новый заказ',
    'Edit Job Card': 'Редактировать заказ',
    '+ New job': '+ Новый заказ',
    '+ Direct job': '+ Прямой заказ',
    'Create job card': 'Создать заказ',
    'Customer complaint': 'Жалоба клиента',
    'Findings / diagnostics': 'Результаты / диагностика',
    'Initial findings': 'Первичные результаты',
    'Work performed': 'Выполненные работы',
    'Mechanic': 'Механик',
    'Unassigned': 'Не назначен',
    'Est. completion': 'План завершения',
    'Customer notes': 'Заметки клиента',
    'Internal notes': 'Внутренние заметки',
    'Labour & Parts': 'Работы и детали',
    'Labour': 'Работы',
    'Parts': 'Детали',
    'Other': 'Другое',
    '+ Add line': '+ Добавить строку',
    'Type': 'Тип',
    'Description': 'Описание',
    'Qty': 'Кол-во',
    'Unit price': 'Цена за ед.',
    'Mark Ready': 'Отметить готовым',
    'Mark Ready & Send SMS': 'Отметить готовым и отправить SMS',
    'Mark Complete': 'Отметить завершённым',
    'Send ready SMS': 'Отправить SMS о готовности',
    'Ready SMS': 'SMS о готовности',
    'Not sent': 'Не отправлено',
    'No labour or parts lines yet': 'Строк работ или деталей пока нет',
    'Direct job': 'Прямой заказ',
    'From booking': 'Из записи',
    'Choose a booking to fill the job card.': 'Выберите запись, чтобы заполнить заказ.',
    'No bookings ready for a job card.': 'Нет записей, готовых для заказа.',
    'Invoice': 'Счёт',
    'Edit Invoice': 'Редактировать счёт',
    'Invoice #': 'Счёт №',
    'Payment method': 'Способ оплаты',
    'VAT rate (%)': 'Ставка VAT (%)',
    'Generate Invoice': 'Создать счёт',
    'View Invoice': 'Открыть счёт',
    'Mark as paid': 'Отметить оплаченным',
    'Print': 'Печать',
    'Open invoice': 'Открыть счёт',
    'No invoices yet': 'Счетов пока нет',
    'Outstanding': 'К оплате',
    'Total collected': 'Всего получено',
    'Booking': 'Запись',
    'New Booking': 'Новая запись',
    'Edit Booking': 'Редактировать запись',
    'Save booking': 'Сохранить запись',
    'Date': 'Дата',
    'Time': 'Время',
    'Reason': 'Причина',
    'Service': 'Сервис',
    'Slot': 'Слот',
    'Full Service': 'Полный сервис',
    'Interim Service': 'Промежуточный сервис',
    'Diagnostics': 'Диагностика',
    'Repair': 'Ремонт',
    'MOT': 'MOT',
    'Today': 'Сегодня',
    'Yesterday': 'Вчера',
    'Week': 'Неделя',
    'Month': 'Месяц',
    'All': 'Все',
    'Active jobs': 'Активные заказы',
    'Revenue': 'Выручка',
    'Customers': 'Клиенты',
    'Stock': 'Склад',
    'Part name': 'Название детали',
    'SKU': 'SKU',
    'Category': 'Категория',
    'Supplier': 'Поставщик',
    'Quantity': 'Количество',
    'Minimum stock level': 'Минимальный остаток',
    'Purchase cost': 'Закупочная цена',
    'Sell price': 'Цена продажи',
    'Margin (%)': 'Маржа (%)',
    'Save inventory item': 'Сохранить позицию склада',
    'Record movement': 'Записать движение',
    'Stock In': 'Приход',
    'Stock Out': 'Расход',
    'Adjustment': 'Корректировка',
    'Export CSV': 'Экспорт CSV',
    'Export PDF': 'Экспорт PDF',
    'Print report': 'Печать отчёта',
    'Search by name, phone, email...': 'Поиск по имени, телефону, email...',
    'Search registration, VIN, make, model, owner...': 'Поиск по номеру, VIN, марке, модели, владельцу...',
    'Search job #, reg, customer, status...': 'Поиск по заказу, номеру, клиенту, статусу...',
    'Search invoice #, customer, reg, status...': 'Поиск по счёту, клиенту, номеру, статусу...',
    'Search part name, SKU, category, supplier...': 'Поиск детали, SKU, категории, поставщика...',
    'Select customer...': 'Выберите клиента...',
    'Select vehicle…': 'Выберите автомобиль…',
    'No phone': 'Нет телефона',
    'No email': 'Нет email',
    'Optional': 'Необязательно',
    'Phone number': 'Номер телефона',
    'Street, town, postcode': 'Улица, город, индекс',
    'Payment due within 7 days': 'Оплата в течение 7 дней',
    'Bank name, sort code, account number': 'Банк, sort code, номер счёта',
    'Settings saved': 'Настройки сохранены',
    'Garage profile saved': 'Профиль гаража сохранён',
    'Vehicle saved': 'Автомобиль сохранён',
    'Vehicle saved under Unknown customer': 'Автомобиль сохранён под неизвестным клиентом',
    'Job saved': 'Заказ сохранён',
    'Booking saved': 'Запись сохранена',
    'Invoice saved': 'Счёт сохранён',
  },
  bg: {
    'Dashboard': 'Табло',
    'Customers': 'Клиенти',
    'Vehicles': 'Автомобили',
    'Job Cards': 'Работни карти',
    'Invoices': 'Фактури',
    'Reports': 'Отчети',
    'Inventory': 'Склад',
    'Calendar': 'Календар',
    'Messages': 'Съобщения',
    'Settings': 'Настройки',
    'Garage': 'Сервиз',
    'Bookings': 'Записвания',
    'Billing': 'Плащане',
    'Account': 'Акаунт',
    'System': 'Система',
    'Workspace': 'Работно пространство',
    'Garage setup': 'Настройка на сервиза',
    'Active': 'Активно',
    'Locked': 'Заключено',
    'Garage name': 'Име на сервиза',
    'Business address': 'Бизнес адрес',
    'Garage phone': 'Телефон на сервиза',
    'Garage email': 'Имейл на сервиза',
    'Website': 'Уебсайт',
    'Company number': 'Фирмен номер',
    'Language': 'Език',
    'Distance unit': 'Единица за разстояние',
    'Currency': 'Валута',
    'Miles (mi)': 'Мили (mi)',
    'Kilometres (km)': 'Километри (km)',
    '1 hour': '1 час',
    '30 minutes': '30 минути',
    'VAT': 'ДДС',
    'Default VAT rate (%)': 'Стандартна ставка ДДС (%)',
    'VAT number': 'ДДС номер',
    'Payment terms': 'Условия за плащане',
    'Bank details': 'Банкови данни',
    'Save and open Dashboard': 'Запази и отвори таблото',
    'Save changes': 'Запази промените',
    'Discard': 'Отказ',
    'Calendar slot size': 'Размер на часовия слот',
    'Allow same-day past times': 'Разреши минали часове за днес',
    'Save booking settings': 'Запази настройките за записвания',
    'Open calendar': 'Отвори календара',
    'Use inventory on job lines': 'Използвай склада в работните редове',
    'Save inventory settings': 'Запази настройките на склада',
    'Open inventory': 'Отвори склада',
    'On': 'Вкл',
    'Off': 'Изкл',
    'Enabled': 'Включено',
    'Disabled': 'Изключено',
    'Login': 'Вход',
    'Logged in': 'Влязъл',
    'Sign out': 'Изход',
    'Login to cloud': 'Вход в облака',
    'Create account': 'Създай акаунт',
    'Email': 'Имейл',
    'Password': 'Парола',
    'Back to login': 'Назад към вход',
    'Verify email': 'Потвърди имейл',
    'Resend code': 'Изпрати кода отново',
    'Save new password': 'Запази нова парола',
    'Forgot password?': 'Забравена парола?',
    'Back up now': 'Архивирай сега',
    'Restore from cloud': 'Възстанови от облака',
    'Check': 'Провери',
    'Check for update': 'Провери за актуализация',
    'Install update': 'Инсталирай актуализация',
    'Current version': 'Текуща версия',
    'Update available': 'Налична актуализация',
    'Ready': 'Готово',
    'New': 'Нов',
    'Diagnosing': 'Диагностика',
    'Waiting Parts': 'Чака части',
    'In Progress': 'В процес',
    'Completed': 'Завършено',
    'Cancelled': 'Отменено',
    'Unpaid': 'Неплатена',
    'Partial': 'Частично',
    'Paid': 'Платена',
    'Draft': 'Чернова',
    'Failed': 'Неуспешно',
    'Sent': 'Изпратено',
    'Pending': 'Изчаква',
    'Confirmed': 'Потвърдено',
    'Customer': 'Клиент',
    'Owner': 'Собственик',
    'Vehicle': 'Автомобил',
    'Vehicle *': 'Автомобил *',
    'Customer *': 'Клиент *',
    'Status': 'Статус',
    'Actions': 'Действия',
    'Cancel': 'Отказ',
    'Save': 'Запази',
    'Delete': 'Изтрий',
    'Edit': 'Редактирай',
    'Add': 'Добави',
    'Create': 'Създай',
    'Search': 'Търсене',
    'Details': 'Детайли',
    'Notes': 'Бележки',
    'No notes recorded.': 'Няма записани бележки.',
    'Subtotal': 'Междинна сума',
    'Total': 'Общо',
    'Deposit paid': 'Платен депозит',
    'Balance due': 'Остатък за плащане',
    'Amount due': 'Сума за плащане',
    'Issued': 'Издадена',
    'Due': 'Срок',
    'Due soon': 'Скоро изтича',
    'Overdue': 'Просрочено',
    'No due date': 'Няма срок',
    'No MOT date': 'Няма MOT дата',
    'No service date': 'Няма сервизна дата',
    'Registration': 'Регистрация',
    'Registration *': 'Регистрация *',
    'Make': 'Марка',
    'Model': 'Модел',
    'Model (optional)': 'Модел (по избор)',
    'Make / Model': 'Марка / модел',
    'VIN': 'VIN',
    'Year': 'Година',
    'Engine': 'Двигател',
    'Fuel': 'Гориво',
    'Fuel type': 'Тип гориво',
    'Colour': 'Цвят',
    'Mileage': 'Пробег',
    'Mileage in': 'Пробег при прием',
    'MOT due': 'MOT до',
    'Service due': 'Сервиз до',
    'Unknown customer': 'Неизвестен клиент',
    'Unknown customer / walk-in': 'Неизвестен клиент / без записване',
    'No owner': 'Няма собственик',
    'No mileage': 'Няма пробег',
    'No engine details': 'Няма данни за двигателя',
    'No active job': 'Няма активна работа',
    'No vehicles found': 'Няма намерени автомобили',
    'No customers match this search': 'Няма клиенти по това търсене',
    'No vehicles match this search': 'Няма автомобили по това търсене',
    'New Vehicle': 'Нов автомобил',
    'Edit Vehicle': 'Редакция на автомобил',
    'Add vehicle': 'Добави автомобил',
    '+ Add vehicle': '+ Добави автомобил',
    'Check DVLA': 'Провери DVLA',
    'Send SMS': 'Изпрати SMS',
    'Send MOT reminder': 'Изпрати MOT напомняне',
    'Send service reminder': 'Изпрати сервизно напомняне',
    'SMS history': 'SMS история',
    'Job': 'Работа',
    'Job card': 'Работна карта',
    'Job card *': 'Работна карта *',
    'New Job Card': 'Нова работна карта',
    'Edit Job Card': 'Редакция на работна карта',
    '+ New job': '+ Нова работа',
    '+ Direct job': '+ Директна работа',
    'Create job card': 'Създай работна карта',
    'Customer complaint': 'Оплакване на клиента',
    'Findings / diagnostics': 'Констатации / диагностика',
    'Initial findings': 'Първоначални констатации',
    'Work performed': 'Извършена работа',
    'Mechanic': 'Механик',
    'Unassigned': 'Неназначен',
    'Est. completion': 'Очаквано завършване',
    'Customer notes': 'Бележки на клиента',
    'Internal notes': 'Вътрешни бележки',
    'Labour & Parts': 'Труд и части',
    'Labour': 'Труд',
    'Parts': 'Части',
    'Other': 'Друго',
    '+ Add line': '+ Добави ред',
    'Type': 'Тип',
    'Description': 'Описание',
    'Qty': 'Кол-во',
    'Unit price': 'Ед. цена',
    'Mark Ready': 'Маркирай готово',
    'Mark Ready & Send SMS': 'Маркирай готово и изпрати SMS',
    'Mark Complete': 'Маркирай завършено',
    'Send ready SMS': 'Изпрати SMS за готовност',
    'Ready SMS': 'SMS за готовност',
    'Not sent': 'Не е изпратено',
    'No labour or parts lines yet': 'Все още няма редове за труд или части',
    'Direct job': 'Директна работа',
    'From booking': 'От записване',
    'Choose a booking to fill the job card.': 'Изберете записване, за да попълните работната карта.',
    'No bookings ready for a job card.': 'Няма записвания, готови за работна карта.',
    'Invoice': 'Фактура',
    'Edit Invoice': 'Редакция на фактура',
    'Invoice #': 'Фактура №',
    'Payment method': 'Метод на плащане',
    'VAT rate (%)': 'Ставка ДДС (%)',
    'Generate Invoice': 'Създай фактура',
    'View Invoice': 'Отвори фактура',
    'Mark as paid': 'Маркирай като платена',
    'Print': 'Печат',
    'Open invoice': 'Отвори фактура',
    'No invoices yet': 'Все още няма фактури',
    'Outstanding': 'Неплатено',
    'Total collected': 'Общо получено',
    'Booking': 'Записване',
    'New Booking': 'Ново записване',
    'Edit Booking': 'Редакция на записване',
    'Save booking': 'Запази записване',
    'Date': 'Дата',
    'Time': 'Час',
    'Reason': 'Причина',
    'Service': 'Услуга',
    'Slot': 'Час',
    'Full Service': 'Пълен сервиз',
    'Interim Service': 'Междинен сервиз',
    'Diagnostics': 'Диагностика',
    'Repair': 'Ремонт',
    'MOT': 'MOT',
    'Today': 'Днес',
    'Yesterday': 'Вчера',
    'Week': 'Седмица',
    'Month': 'Месец',
    'All': 'Всички',
    'Active jobs': 'Активни работи',
    'Revenue': 'Приход',
    'Customers': 'Клиенти',
    'Stock': 'Склад',
    'Part name': 'Име на част',
    'SKU': 'SKU',
    'Category': 'Категория',
    'Supplier': 'Доставчик',
    'Quantity': 'Количество',
    'Minimum stock level': 'Минимална наличност',
    'Purchase cost': 'Покупна цена',
    'Sell price': 'Продажна цена',
    'Margin (%)': 'Марж (%)',
    'Save inventory item': 'Запази складов артикул',
    'Record movement': 'Запиши движение',
    'Stock In': 'Вход',
    'Stock Out': 'Изход',
    'Adjustment': 'Корекция',
    'Export CSV': 'Експорт CSV',
    'Export PDF': 'Експорт PDF',
    'Print report': 'Печат на отчет',
    'Search by name, phone, email...': 'Търсене по име, телефон, имейл...',
    'Search registration, VIN, make, model, owner...': 'Търсене по регистрация, VIN, марка, модел, собственик...',
    'Search job #, reg, customer, status...': 'Търсене по работа, регистрация, клиент, статус...',
    'Search invoice #, customer, reg, status...': 'Търсене по фактура, клиент, регистрация, статус...',
    'Search part name, SKU, category, supplier...': 'Търсене по част, SKU, категория, доставчик...',
    'Select customer...': 'Изберете клиент...',
    'Select vehicle…': 'Изберете автомобил…',
    'No phone': 'Няма телефон',
    'No email': 'Няма имейл',
    'Optional': 'По избор',
    'Phone number': 'Телефонен номер',
    'Street, town, postcode': 'Улица, град, пощенски код',
    'Payment due within 7 days': 'Плащане в рамките на 7 дни',
    'Bank name, sort code, account number': 'Банка, sort code, номер на сметка',
    'Settings saved': 'Настройките са запазени',
    'Garage profile saved': 'Профилът на сервиза е запазен',
    'Vehicle saved': 'Автомобилът е запазен',
    'Vehicle saved under Unknown customer': 'Автомобилът е запазен към неизвестен клиент',
    'Job saved': 'Работата е запазена',
    'Booking saved': 'Записването е запазено',
    'Invoice saved': 'Фактурата е запазена',
  },
});
const DEFAULT_MESSAGE_TEMPLATES = Object.freeze({
  booking_confirmation: 'Hi {{customer_name}}, your booking with {{garage_name}} is confirmed for {{booking_date}} at {{booking_time}}. Vehicle: {{vehicle_reg}}. If you need to change it, please call {{garage_phone}}.',
  booking_reminder: 'Hi {{customer_name}}, your booking with {{garage_name}} is confirmed for {{booking_date}} at {{booking_time}}. Vehicle: {{vehicle_reg}}. If you need to change it, please call {{garage_phone}}.',
  job_completed: 'Hi {{customer_name}}, your vehicle {{vehicle_reg}} is ready for collection. Amount to pay: £{{amount_due}}. {{garage_name}}',
  ready_collection: 'Hi {{customer_name}}, your vehicle {{vehicle_reg}} is ready for collection. Amount to pay: £{{amount_due}}. {{garage_name}}',
  mot_reminder: 'Hi {{customer_name}}, MOT for {{vehicle_reg}} is due on {{mot_due_date}}. Please contact {{garage_name}} on {{garage_phone}} to book your MOT.',
  service_reminder: 'Hi {{customer_name}}, your vehicle {{vehicle_reg}} is due for service on {{service_due_date}}. Please contact {{garage_name}} on {{garage_phone}} to book.',
  custom: 'Hi {{customer_name}}, this is {{garage_name}}.',
});
const DEFAULT_MESSAGE_SETTINGS = Object.freeze({
  sms_enabled: false,
  auto_booking_sms: false,
  auto_job_completed_sms: false,
  manual_sms_enabled: true,
  booking_reminders_enabled: true,
  ready_messages_enabled: true,
  mot_reminders_enabled: true,
  service_reminders_enabled: true,
  automatic_reminder_time: '09:00',
  reminder_30_days: true,
  reminder_14_days: true,
  reminder_7_days: true,
  reminder_due_today: true,
  booking_days_before: 1,
  mot_days_before: 30,
  service_days_before: 30,
  garage_phone: '',
  booking_template: DEFAULT_MESSAGE_TEMPLATES.booking_confirmation,
  ready_template: DEFAULT_MESSAGE_TEMPLATES.job_completed,
  mot_template: DEFAULT_MESSAGE_TEMPLATES.mot_reminder,
  service_template: DEFAULT_MESSAGE_TEMPLATES.service_reminder,
  completed_template: DEFAULT_MESSAGE_TEMPLATES.job_completed,
});
const MESSAGE_CATEGORIES = Object.freeze({
  booking_confirmation: { label: 'Booking confirmation', tone: 'blue' },
  booking_reminder: { label: 'Booking confirmation', tone: 'blue' },
  job_completed: { label: 'Ready for collection', tone: 'green' },
  ready_collection: { label: 'Ready for collection', tone: 'green' },
  mot_reminder: { label: 'MOT reminder', tone: 'amber' },
  service_reminder: { label: 'Service reminder', tone: 'blue' },
  custom: { label: 'Custom SMS', tone: 'gray' },
});
const SMS_TEMPLATE_VARIABLES = Object.freeze([
  '{{customer_name}}',
  '{{customer_phone}}',
  '{{vehicle_reg}}',
  '{{vehicle_make}}',
  '{{vehicle_model}}',
  '{{booking_date}}',
  '{{booking_time}}',
  '{{mot_due_date}}',
  '{{service_due_date}}',
  '{{amount_due}}',
  '{{garage_name}}',
  '{{garage_phone}}',
]);
const NAV_ITEMS = [
  { screen:'dashboard', path:'M3 3h5v5H3zM9 3h5v5H9zM3 9h5v5H3zM9 9h5v5H9z', label:'Dashboard' },
  { screen:'admin', path:'M8 2l5 2v3c0 3.2-2 5.9-5 7-3-1.1-5-3.8-5-7V4l5-2zm0 3v6m-2-3h4', label:'Admin', adminOnly:true },
  { screen:'clients', path:'M8 8a3 3 0 100-6 3 3 0 000 6zm-5 9a5 5 0 0110 0H3z', label:'Customers' },
  { screen:'vehicles', path:'M3 8l1.5-3h9L15 8v5H3V8zM5 13v1a1 1 0 002 0v-1M11 13v1a1 1 0 002 0v-1', label:'Vehicles' },
  { screen:'jobs', path:'M4 2h8l3 3v11H4V2zm3 5h4m-4 3h4m-4 3h2', label:'Jobs' },
  { screen:'invoices', path:'M4 2h8l3 3v11H4V2zm3 4h4m-4 3h4m-4 3h4', label:'Invoices' },
  { screen:'reports', path:'M3 13h10M4 11V7m4 4V4m4 7V2M3 14h10', label:'Reports' },
  { screen:'inventory', path:'M3 4l5-2 5 2v8l-5 2-5-2V4zm0 0 5 2 5-2M8 6v8', label:'Inventory' },
  { screen:'calendar', path:'M2 5h12v10H2zm3-3v2m5-2v2m-8 4h10', label:'Calendar' },
  { screen:'messages', path:'M2.5 4.5h11v7h-7L3 14v-2.5h-.5v-7zm2.2 2.2h6.6M4.7 9h4.8', label:'Messages' },
  { screen:'settings', path:'M8 2.6l1 .9 1.3-.4 1.1 1.9-.8 1.1.2 1.3 1.1.8-1.1 1.9-1.3-.4-1 .9H6.9l-1-.9-1.3.4-1.1-1.9 1.1-.8.2-1.3-.8-1.1 1.1-1.9 1.3.4 1-.9H8zm0 3a2.4 2.4 0 100 4.8 2.4 2.4 0 000-4.8z', label:'Settings' },
];
const SETTINGS_CATEGORIES = [
  { key: 'garage', label: 'Garage' },
  { key: 'booking', label: 'Bookings' },
  { key: 'inventory', label: 'Inventory' },
  { key: 'messages', label: 'Messages' },
  { key: 'billing', label: 'Billing' },
  { key: 'account', label: 'Account' },
  { key: 'system', label: 'System' },
];
const NAV_ORDER_STORAGE_KEY = 'garage-crm.nav-order';
const BILLING_PENDING_CHECKOUT_STORAGE_KEY = 'garage-crm.billing.pending-checkout';
const BILLING_REFERRAL_CODE_STORAGE_KEY = 'garage-crm.billing.referral-code';
const GARAGE_SETUP_PENDING_EMAIL_STORAGE_KEY = 'garage-crm.garage-setup.pending-email';
let navPointerState = null;
let suppressNavClick = false;
let clickablePointerState = null;
let automaticSmsReminderTimerId = null;

function getSettings() { return { ...DEFAULT_SETTINGS, ...(state.settings || {}) }; }
function normalizeSettingText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength);
}
function normalizeDistanceUnit(value) { return String(value || DEFAULT_SETTINGS.distance_unit).toLowerCase() === 'km' ? 'km' : 'mi'; }
function normalizeCurrency(value) {
  const code = String(value || DEFAULT_SETTINGS.currency).trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : DEFAULT_SETTINGS.currency;
}
function normalizeLanguage(value) {
  const code = String(value || DEFAULT_SETTINGS.language).trim().toLowerCase();
  return LANGUAGE_OPTIONS.some(language => language.value === code) ? code : DEFAULT_SETTINGS.language;
}
function normalizeVatEnabled(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_SETTINGS.vat_enabled;
  return value === true || value === 1 || value === '1' || value === 'true';
}
function normalizeVatRate(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SETTINGS.default_vat_rate;
  return Math.max(0, Math.min(100, Math.round(parsed * 100) / 100));
}
function normalizeBookingSlotInterval(value) { return Number(value) === 30 ? 30 : 60; }
function normalizeAllowPastBookingTimes(value) { return value === true || value === 1 || value === '1' || value === 'true'; }
function normalizeInventoryEnabled(value) { return value === true || value === 1 || value === '1' || value === 'true'; }
function buildAppSettingsPayload(overrides = {}) {
  const settings = { ...getSettings(), ...(overrides || {}) };
  return {
    garage_name: String(settings.garage_name || '').trim() || DEFAULT_SETTINGS.garage_name,
    garage_address: normalizeSettingText(settings.garage_address, 800),
    garage_phone: normalizeSettingText(settings.garage_phone, 80),
    garage_email: normalizeSettingText(settings.garage_email, 120),
    garage_website: normalizeSettingText(settings.garage_website, 160),
    vat_number: normalizeSettingText(settings.vat_number, 80),
    company_number: normalizeSettingText(settings.company_number, 80),
    bank_details: normalizeSettingText(settings.bank_details, 1000),
    payment_terms: normalizeSettingText(settings.payment_terms, 1000),
    language: normalizeLanguage(settings.language),
    distance_unit: normalizeDistanceUnit(settings.distance_unit),
    currency: normalizeCurrency(settings.currency),
    vat_enabled: normalizeVatEnabled(settings.vat_enabled),
    default_vat_rate: normalizeVatRate(settings.default_vat_rate),
    booking_slot_interval: normalizeBookingSlotInterval(settings.booking_slot_interval),
    allow_past_booking_times: normalizeAllowPastBookingTimes(settings.allow_past_booking_times),
    inventory_enabled: normalizeInventoryEnabled(settings.inventory_enabled),
  };
}
function getAppLanguage() {
  return normalizeLanguage(getSettings().language);
}

function translateUiText(text, language = getAppLanguage()) {
  const raw = String(text ?? '');
  const dictionary = UI_TRANSLATIONS[language];
  if (!dictionary || !raw.trim()) return raw;
  const trimmed = raw.trim();
  const exact = dictionary[trimmed];
  if (exact) return raw.replace(trimmed, exact);

  const unknownMatch = trimmed.match(/^Unknown customer #(\d+)$/i);
  if (unknownMatch && dictionary['Unknown customer']) {
    const hash = language === 'bg' ? '№' : '#';
    return raw.replace(trimmed, `${dictionary['Unknown customer']} ${hash}${unknownMatch[1]}`);
  }

  const openedMatch = trimmed.match(/^Opened (.+)$/);
  if (openedMatch) return raw.replace(trimmed, language === 'bg' ? `Отворено ${openedMatch[1]}` : `Открыто ${openedMatch[1]}`);

  const fromBookingMatch = trimmed.match(/^From booking (.+)$/);
  if (fromBookingMatch) return raw.replace(trimmed, language === 'bg' ? `От записване ${fromBookingMatch[1]}` : `Из записи ${fromBookingMatch[1]}`);

  const mechanicMatch = trimmed.match(/^Mechanic:\s*(.+)$/);
  if (mechanicMatch) {
    const mechanic = dictionary.Mechanic || 'Mechanic';
    const value = translateUiText(mechanicMatch[1], language).trim();
    return raw.replace(trimmed, `${mechanic}: ${value}`);
  }

  const countMatch = trimmed.match(/^(\d+)\s+(vehicle|vehicles|job cards|bookings|invoices|clients|parts)$/i);
  if (countMatch) {
    const count = countMatch[1];
    const noun = countMatch[2].toLowerCase();
    const nouns = {
      ru: { vehicle: 'авто', vehicles: 'авто', 'job cards': 'заказов', bookings: 'записей', invoices: 'счетов', clients: 'клиентов', parts: 'деталей' },
      bg: { vehicle: 'автомобил', vehicles: 'автомобила', 'job cards': 'работни карти', bookings: 'записвания', invoices: 'фактури', clients: 'клиенти', parts: 'части' },
    };
    return raw.replace(trimmed, `${count} ${nouns[language]?.[noun] || noun}`);
  }

  return raw;
}

function translateToastMessage(message) {
  return translateUiText(message);
}

function uiText(text) {
  return escHtml(translateUiText(text));
}

function shouldSkipTranslationNode(node) {
  const parent = node?.parentElement;
  if (!parent) return true;
  return Boolean(parent.closest('script, style, textarea, select, option, input, [contenteditable="true"], [data-no-translate]'));
}

function applyLanguageToDom(root = document) {
  const language = getAppLanguage();
  document.documentElement.lang = language;
  if (language === 'en') return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (shouldSkipTranslationNode(node)) return NodeFilter.FILTER_REJECT;
      return node.nodeValue?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  textNodes.forEach(node => {
    const translated = translateUiText(node.nodeValue, language);
    if (translated !== node.nodeValue) node.nodeValue = translated;
  });

  const attrSelector = '[placeholder], [title], [aria-label]';
  root.querySelectorAll?.(attrSelector).forEach(element => {
    ['placeholder', 'title', 'aria-label'].forEach(attribute => {
      const value = element.getAttribute(attribute);
      if (!value) return;
      const translated = translateUiText(value, language);
      if (translated !== value) element.setAttribute(attribute, translated);
    });
  });
}
function getMessageSettings() {
  const settings = { ...DEFAULT_MESSAGE_SETTINGS, ...(state.messageSettings || {}) };
  return { ...settings, manual_sms_enabled: true };
}
function normalizeMessageBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 1 || value === '1' || value === 'true';
}
function normalizeLeadDays(value, fallback = 30) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(365, parsed));
}
function normalizeReminderSendTime(value) {
  const match = String(value || DEFAULT_MESSAGE_SETTINGS.automatic_reminder_time).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return DEFAULT_MESSAGE_SETTINGS.automatic_reminder_time;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return DEFAULT_MESSAGE_SETTINGS.automatic_reminder_time;
  }
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
function buildMessageSettingsPayload(overrides = {}) {
  const settings = { ...getMessageSettings(), ...(overrides || {}) };
  return {
    sms_enabled: normalizeMessageBool(settings.sms_enabled, DEFAULT_MESSAGE_SETTINGS.sms_enabled),
    auto_booking_sms: normalizeMessageBool(settings.auto_booking_sms, DEFAULT_MESSAGE_SETTINGS.auto_booking_sms),
    auto_job_completed_sms: normalizeMessageBool(settings.auto_job_completed_sms, DEFAULT_MESSAGE_SETTINGS.auto_job_completed_sms),
    manual_sms_enabled: true,
    booking_reminders_enabled: normalizeMessageBool(settings.booking_reminders_enabled, DEFAULT_MESSAGE_SETTINGS.booking_reminders_enabled),
    ready_messages_enabled: normalizeMessageBool(settings.ready_messages_enabled, DEFAULT_MESSAGE_SETTINGS.ready_messages_enabled),
    mot_reminders_enabled: normalizeMessageBool(settings.mot_reminders_enabled, DEFAULT_MESSAGE_SETTINGS.mot_reminders_enabled),
    service_reminders_enabled: normalizeMessageBool(settings.service_reminders_enabled, DEFAULT_MESSAGE_SETTINGS.service_reminders_enabled),
    reminder_30_days: normalizeMessageBool(settings.reminder_30_days, DEFAULT_MESSAGE_SETTINGS.reminder_30_days),
    reminder_14_days: normalizeMessageBool(settings.reminder_14_days, DEFAULT_MESSAGE_SETTINGS.reminder_14_days),
    reminder_7_days: normalizeMessageBool(settings.reminder_7_days, DEFAULT_MESSAGE_SETTINGS.reminder_7_days),
    reminder_due_today: normalizeMessageBool(settings.reminder_due_today, DEFAULT_MESSAGE_SETTINGS.reminder_due_today),
    booking_days_before: normalizeLeadDays(settings.booking_days_before, DEFAULT_MESSAGE_SETTINGS.booking_days_before),
    mot_days_before: normalizeLeadDays(settings.mot_days_before, DEFAULT_MESSAGE_SETTINGS.mot_days_before),
    service_days_before: normalizeLeadDays(settings.service_days_before, DEFAULT_MESSAGE_SETTINGS.service_days_before),
    automatic_reminder_time: normalizeReminderSendTime(settings.automatic_reminder_time),
    garage_phone: String(settings.garage_phone || '').trim(),
    booking_template: String(settings.booking_template || DEFAULT_MESSAGE_TEMPLATES.booking_confirmation).trim(),
    ready_template: String(settings.ready_template || DEFAULT_MESSAGE_TEMPLATES.job_completed).trim(),
    mot_template: String(settings.mot_template || DEFAULT_MESSAGE_TEMPLATES.mot_reminder).trim(),
    service_template: String(settings.service_template || DEFAULT_MESSAGE_TEMPLATES.service_reminder).trim(),
    completed_template: String(settings.completed_template || settings.ready_template || DEFAULT_MESSAGE_TEMPLATES.job_completed).trim(),
  };
}
function isMessagingConfigured() {
  return isCloudSignedIn() && getCloudSession().configured;
}
function getGarageName() {
  const name = String(getSettings().garage_name || '').trim();
  return name || DEFAULT_SETTINGS.garage_name;
}
function getGarageContactPhone() {
  return String(getMessageSettings().garage_phone || getSettings().garage_phone || '').trim();
}
function getGarageAddressLines() {
  return String(getSettings().garage_address || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}
function getDistanceUnit() { return normalizeDistanceUnit(getSettings().distance_unit); }
function isVatEnabled() { return normalizeVatEnabled(getSettings().vat_enabled); }
function getDefaultVatRate() { return normalizeVatRate(getSettings().default_vat_rate); }
function getAppliedVatRate() { return isVatEnabled() ? getDefaultVatRate() : 0; }
function getVatAmount(subtotal, vatRate = getAppliedVatRate()) { return subtotal * vatRate / 100; }
function shouldShowInvoiceVat() { return isVatEnabled(); }
function formatVatRate(rate) {
  return normalizeVatRate(rate).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}
function getVatLabel(rate) {
  return `VAT (${formatVatRate(rate)}%)`;
}
function getBookingSlotInterval() { return normalizeBookingSlotInterval(getSettings().booking_slot_interval); }
function getAllowPastBookingTimes() { return normalizeAllowPastBookingTimes(getSettings().allow_past_booking_times); }
function isInventoryEnabled() { return normalizeInventoryEnabled(getSettings().inventory_enabled); }
function getDistanceLabel() { return getDistanceUnit() === 'km' ? 'Distance' : 'Mileage'; }
function getDistanceLabelWithUnit() { return `${getDistanceLabel()} (${getDistanceUnit()})`; }
function getDistanceInLabel() { return `${getDistanceLabel()} in (${getDistanceUnit()})`; }
function formatDateInputValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
function timeStringToMinutes(time) {
  const [hours, minutes] = String(time || '').split(':').map(part => parseInt(part, 10));
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return hours * 60 + minutes;
}
function isPastBookingTime(date, time, now = new Date()) {
  if (!date || !time) return false;
  const today = formatDateInputValue(now);
  if (date < today) return true;
  if (date > today) return false;
  const slotMinutes = timeStringToMinutes(time);
  if (slotMinutes === null) return false;
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  return slotMinutes < currentMinutes;
}
function canBookTime(date, time) {
  return getAllowPastBookingTimes() || !isPastBookingTime(date, time);
}
function getCalendarTimeSlots(interval = getBookingSlotInterval()) {
  return interval === 30 ? BOOKING_TIMES.slice() : BOOKING_TIMES.filter(time => time.endsWith(':00'));
}
function getBookingTimeOptions(selectedTime = '', interval = getBookingSlotInterval()) {
  const options = getCalendarTimeSlots(interval);
  if (selectedTime && !options.includes(selectedTime)) {
    options.push(selectedTime);
    options.sort((a, b) => a.localeCompare(b));
  }
  return options;
}
function getFilteredBookingTimeOptions(date, selectedTime = '', { preserveSelected = true } = {}) {
  const options = getBookingTimeOptions(selectedTime);
  if (getAllowPastBookingTimes()) return options;
  const filtered = options.filter(time => !isPastBookingTime(date, time));
  if (preserveSelected && selectedTime && options.includes(selectedTime) && !filtered.includes(selectedTime)) {
    filtered.push(selectedTime);
  }
  return filtered.sort((a, b) => a.localeCompare(b));
}
function renderBookingTimeOptions(options, selectedTime = '') {
  if (!options.length) return '<option value="">No available times</option>';
  return options.map(time => `<option ${selectedTime === time ? 'selected' : ''}>${time}</option>`).join('');
}
function getBookableBookingDateTime(presetDate = '', presetTime = '') {
  let nextDate = presetDate || formatDateInputValue();
  const today = formatDateInputValue();
  if (!getAllowPastBookingTimes() && nextDate < today) nextDate = today;

  let nextTime = presetTime || '';
  const options = getFilteredBookingTimeOptions(nextDate, nextTime, { preserveSelected: false });
  if (options.length) {
    if (!nextTime || !options.includes(nextTime)) nextTime = options[0];
    return { date: nextDate, time: nextTime };
  }

  if (!getAllowPastBookingTimes() && nextDate === today) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowDate = formatDateInputValue(tomorrow);
    const tomorrowOptions = getFilteredBookingTimeOptions(tomorrowDate, '', { preserveSelected: false });
    return { date: tomorrowDate, time: tomorrowOptions[0] || getBookingTimeOptions()[0] || '09:00' };
  }

  return { date: nextDate, time: nextTime || getBookingTimeOptions()[0] || '09:00' };
}
function isCurrentUserAdmin() {
  return Boolean(state.adminAccess?.isAdmin);
}
function getAvailableNavItems() {
  return NAV_ITEMS.filter(item => !item.adminOnly || isCurrentUserAdmin());
}
function getDefaultNavOrder() { return getAvailableNavItems().map(item => item.screen); }
function normalizeNavOrder(order) {
  const allowed = new Set(getDefaultNavOrder());
  const seen = new Set();
  const normalized = [];
  if (Array.isArray(order)) {
    order.forEach(screen => {
      if (allowed.has(screen) && !seen.has(screen)) {
        normalized.push(screen);
        seen.add(screen);
      }
    });
  }
  getDefaultNavOrder().forEach(screen => {
    if (!seen.has(screen)) normalized.push(screen);
  });
  return normalized;
}
function loadNavOrder() {
  try {
    const raw = window.localStorage.getItem(NAV_ORDER_STORAGE_KEY);
    return normalizeNavOrder(raw ? JSON.parse(raw) : []);
  } catch {
    return getDefaultNavOrder();
  }
}
function getNavOrder() {
  if (!Array.isArray(state.navOrder) || state.navOrder.length === 0) {
    state.navOrder = loadNavOrder();
  }
  return normalizeNavOrder(state.navOrder);
}
function persistNavOrder(order) {
  state.navOrder = normalizeNavOrder(order);
  try {
    window.localStorage.setItem(NAV_ORDER_STORAGE_KEY, JSON.stringify(state.navOrder));
  } catch {}
}
function setNavOrder(order) {
  state.navOrder = normalizeNavOrder(order);
  return state.navOrder;
}
function getOrderedNavItems() {
  const order = getNavOrder();
  const itemMap = new Map(getAvailableNavItems().map(item => [item.screen, item]));
  return order.map(screen => itemMap.get(screen)).filter(Boolean);
}
function getCurrentAppPath() {
  if (typeof window === 'undefined') return '/';
  return window.location.pathname.replace(/\/+$/, '') || '/';
}
function isAdminRoutePath() {
  const path = getCurrentAppPath();
  return path === '/admin' || path === '/admin/dashboard';
}
function setAppPath(path, { replace = false } = {}) {
  if (typeof window === 'undefined' || isAuthCallbackRoute()) return;
  const targetPath = path || '/';
  if (getCurrentAppPath() === targetPath) return;
  try {
    window.history[replace ? 'replaceState' : 'pushState']({}, document.title, targetPath);
  } catch (error) {
    console.warn('Unable to update route', error);
  }
}
function setRouteForScreen(screen, options = {}) {
  setAppPath(screen === 'admin' ? '/admin/dashboard' : '/', options);
}
function applyRouteFromLocation() {
  captureBillingReferralCodeFromUrl();
  if (isAdminRoutePath()) {
    state.screen = 'admin';
    state.adminSection = 'dashboard';
  } else if (state.screen === 'admin') {
    state.screen = 'dashboard';
    state.adminSection = 'dashboard';
  }
}
function resetAdminAccess() {
  state.adminAccess = {
    userId: '',
    checked: false,
    isAdmin: false,
    loading: false,
    error: '',
    profile: null,
  };
}
function resetAdminStats() {
  state.adminStats = {
    loading: false,
    error: '',
    data: null,
  };
}
function resetAdminReferrals() {
  state.adminReferrals = {
    loading: false,
    error: '',
    data: null,
  };
  state.adminReferralEditId = '';
  state.adminReferralSaving = false;
}
async function ensureAdminAccess({ force = false } = {}) {
  const userId = getCloudSession().user_id || '';
  if (!userId) {
    resetAdminAccess();
    resetAdminStats();
    resetAdminReferrals();
    return false;
  }
  const current = state.adminAccess || {};
  if (current.userId && current.userId !== userId) {
    resetAdminStats();
    resetAdminReferrals();
  }
  if (!force && current.checked && current.userId === userId) {
    return Boolean(current.isAdmin);
  }

  state.adminAccess = {
    userId,
    checked: false,
    isAdmin: false,
    loading: true,
    error: '',
    profile: null,
  };

  try {
    const adminAuth = await useAdminAuth();
    const isAdmin = Boolean(adminAuth.isAdmin);
    state.adminAccess = {
      userId,
      checked: true,
      isAdmin,
      loading: false,
      error: adminAuth.error || '',
      profile: adminAuth.profile || null,
    };
    return isAdmin;
  } catch (error) {
    const message = getErrorMessage(error);
    console.warn('Unable to verify admin access', error);
    state.adminAccess = {
      userId,
      checked: true,
      isAdmin: false,
      loading: false,
      error: message,
      profile: null,
    };
    resetAdminStats();
    resetAdminReferrals();
    return false;
  }
}
async function loadAdminDashboardStats({ force = false } = {}) {
  if (!isCurrentUserAdmin()) return null;
  const current = state.adminStats || {};
  if (!force && current.data && !current.error) return current.data;
  if (current.loading) return current.data || null;

  state.adminStats = {
    loading: true,
    error: '',
    data: force ? null : (current.data || null),
  };

  try {
    const data = await fetchAdminDashboardStats();
    state.adminStats = {
      loading: false,
      error: '',
      data,
    };
    return data;
  } catch (error) {
    const message = getErrorMessage(error);
    console.warn('Unable to load admin statistics', error);
    state.adminStats = {
      loading: false,
      error: message,
      data: null,
    };
    return null;
  }
}
async function loadAdminReferrals({ force = false } = {}) {
  if (!isCurrentUserAdmin()) return null;
  const current = state.adminReferrals || {};
  if (!force && current.data && !current.error) return current.data;
  if (current.loading) return current.data || null;

  state.adminReferrals = {
    loading: true,
    error: '',
    data: force ? null : (current.data || null),
  };

  try {
    const data = await fetchAdminReferrals();
    state.adminReferrals = {
      loading: false,
      error: '',
      data,
    };
    return data;
  } catch (error) {
    const message = getErrorMessage(error);
    console.warn('Unable to load admin referrals', error);
    state.adminReferrals = {
      loading: false,
      error: message,
      data: current.data || null,
    };
    return null;
  }
}
function renderAdminScreenContent() {
  let adminStats = state.adminStats || { loading: false, error: '', data: null };
  let adminReferrals = state.adminReferrals || { loading: false, error: '', data: null };

  if (!adminStats.loading && !adminStats.data && !adminStats.error) {
    void loadAdminDashboardStats({ force: true }).then(() => {
      if (state.screen === 'admin') void renderInPlace();
    });
    adminStats = state.adminStats || adminStats;
  }
  if (state.adminSection === 'referrals' && !adminReferrals.loading && !adminReferrals.data && !adminReferrals.error) {
    void loadAdminReferrals({ force: true }).then(() => {
      if (state.screen === 'admin' && state.adminSection === 'referrals') void renderInPlace();
    });
    adminReferrals = state.adminReferrals || adminReferrals;
  }

  return renderAdminDashboardPage({
    section: state.adminSection,
    stats: adminStats.data || null,
    referrals: adminReferrals.data || null,
    loading: Boolean(adminStats.loading),
    error: adminStats.error || '',
    referralsLoading: Boolean(adminReferrals.loading),
    referralsError: adminReferrals.error || '',
    referralSaving: Boolean(state.adminReferralSaving),
    referralEditId: state.adminReferralEditId || '',
    profile: state.adminAccess?.profile || null,
  });
}
async function refreshAdminDashboard() {
  if (!(await ensureAdminAccess({ force: true }))) {
    state.screen = 'dashboard';
    setRouteForScreen('dashboard', { replace: true });
    await renderInPlace();
    return;
  }
  await loadAdminDashboardStats({ force: true });
  if (state.adminSection === 'referrals') await loadAdminReferrals({ force: true });
  await renderInPlace();
}
async function setAdminSection(section) {
  state.adminSection = normalizeAdminSection(section);
  if (state.adminSection === 'referrals') {
    void loadAdminReferrals().then(() => {
      if (state.screen === 'admin' && state.adminSection === 'referrals') void renderInPlace();
    });
  }
  await renderInPlace();
}
function getAdminReferralFormInput() {
  const code = String(document.getElementById('admin-referral-code')?.value || '').trim().toUpperCase();
  const referrerName = String(document.getElementById('admin-referral-name')?.value || '').trim();
  const referrerEmail = String(document.getElementById('admin-referral-email')?.value || '').trim();
  const commissionPercent = Number(document.getElementById('admin-referral-percent')?.value || 20);
  const payoutMonths = Number(document.getElementById('admin-referral-months')?.value || 3);
  const status = String(document.getElementById('admin-referral-status')?.value || 'active') === 'paused' ? 'paused' : 'active';
  const notes = String(document.getElementById('admin-referral-notes')?.value || '').trim();
  return {
    code,
    referrerName,
    referrerEmail,
    commissionPercent: Number.isFinite(commissionPercent) ? commissionPercent : 20,
    payoutMonths: Number.isFinite(payoutMonths) ? payoutMonths : 3,
    status,
    notes,
  };
}
async function saveAdminReferralCode() {
  if (!isCurrentUserAdmin()) return;
  const editId = state.adminReferralEditId || '';
  const input = getAdminReferralFormInput();

  if (!editId && !/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(input.code)) {
    state.adminReferrals = { ...(state.adminReferrals || {}), loading: false, error: 'Use a code like GARAGE20, 3-32 characters.', data: state.adminReferrals?.data || null };
    await renderInPlace();
    return;
  }
  if (!input.referrerName) {
    state.adminReferrals = { ...(state.adminReferrals || {}), loading: false, error: 'Referrer name is required.', data: state.adminReferrals?.data || null };
    await renderInPlace();
    return;
  }

  state.adminReferralSaving = true;
  state.adminReferrals = { ...(state.adminReferrals || {}), error: '' };
  await renderInPlace();

  try {
    if (editId) {
      await updateAdminReferralCode(editId, input);
    } else {
      await createAdminReferralCode(input);
    }
    state.adminReferralEditId = '';
    await loadAdminReferrals({ force: true });
  } catch (error) {
    state.adminReferrals = {
      loading: false,
      error: getErrorMessage(error),
      data: state.adminReferrals?.data || null,
    };
  } finally {
    state.adminReferralSaving = false;
    await renderInPlace();
  }
}
async function editAdminReferralCode(id) {
  state.adminReferralEditId = String(id || '');
  await renderInPlace();
}
async function cancelAdminReferralEdit() {
  state.adminReferralEditId = '';
  await renderInPlace();
}
async function markAdminReferralCommissionPaid(id) {
  if (!isCurrentUserAdmin()) return;
  const commissionId = String(id || '');
  if (!commissionId) return;
  const confirmed = typeof window === 'undefined' ? true : window.confirm('Mark this referral commission as paid?');
  if (!confirmed) return;

  state.adminReferralSaving = true;
  state.adminReferrals = { ...(state.adminReferrals || {}), error: '' };
  await renderInPlace();

  try {
    await markAdminReferralCommissionPaidService(commissionId);
    await loadAdminReferrals({ force: true });
  } catch (error) {
    state.adminReferrals = {
      loading: false,
      error: getErrorMessage(error),
      data: state.adminReferrals?.data || null,
    };
  } finally {
    state.adminReferralSaving = false;
    await renderInPlace();
  }
}
function normalizeSettingsCategory(category) {
  const key = String(category || '').trim().toLowerCase();
  return SETTINGS_CATEGORIES.some(item => item.key === key) ? key : SETTINGS_CATEGORIES[0].key;
}
function isBillingViewActive() {
  return state.screen === 'billing' || (state.screen === 'settings' && normalizeSettingsCategory(state.settingsCategory) === 'billing');
}

// ── HELPERS ───────────────────────────────────────────────────────────────
function fmtQty(n) { return Number.isInteger(n) ? String(n) : Number(n || 0).toFixed(2).replace(/0+$/, '').replace(/\.$/, ''); }
function fmtPercent(n) { return `${fmtQty(Number(n || 0))}%`; }
function fmtDate(s) { if (!s) return '—'; return new Date(s + 'T00:00:00').toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric'}); }
function initials(name) { return (name||'?').split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase(); }
function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmt(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return '—';
  const currency = normalizeCurrency(getSettings().currency);
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}
function fmtDistanceValue(n) { return Number(n || 0).toLocaleString('en-GB'); }
function fmtDistance(n) { return `${fmtDistanceValue(n)} ${getDistanceUnit()}`; }
function parseDistanceInput(value, fallback = 0) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function fmtDateTime(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return escHtml(s);
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
function applyAppSettingsToChrome() {
  const nameEl = document.getElementById('garage-name');
  if (nameEl) nameEl.textContent = getGarageName();
  document.title = getGarageName();
}
function renderPill(label, tone = 'gray', className = '') {
  return `<span class="badge badge-${tone} status-pill ${className}">${escHtml(label)}</span>`;
}

function StatusBadge(status) {
  const map = {
    New: 'gray',
    Booked: 'blue',
    Confirmed: 'blue',
    Diagnosing: 'blue',
    'In Progress': 'blue',
    'Waiting Parts': 'amber',
    'Waiting for Parts': 'amber',
    Waiting: 'amber',
    Ready: 'green',
    Completed: 'green',
    Invoiced: 'blue',
    Paid: 'green',
    Unpaid: 'red',
    Partial: 'amber',
    Pending: 'amber',
    Overdue: 'red',
    Cancelled: 'gray',
    Low: 'amber',
    Reorder: 'amber',
    Critical: 'red',
    Good: 'green',
    'Stock In': 'green',
    'Stock Out': 'red',
    Adjustment: 'blue',
    Sent: 'green',
    sent: 'green',
    Failed: 'red',
    failed: 'red',
    Draft: 'gray',
    draft: 'gray',
    Queued: 'amber',
    queued: 'amber',
    pending: 'amber',
  };
  return renderPill(status, map[status] || 'gray');
}
function statusBadge(s) {
  return StatusBadge(s);
}

const UI_ICON_PATHS = {
  phone: 'M6.6 2.5 8 5.8 6.1 7c.8 1.6 2.1 2.9 3.7 3.7L11 8.8l3.3 1.4-.6 3.2c-.1.5-.6.9-1.1.9C6.6 14.3 1.7 9.4 1.7 3.4c0-.5.4-1 .9-1.1l4-.8z',
  mail: 'M2.5 4h11v8h-11V4zm0 0L8 8.2 13.5 4',
  calendar: 'M3 4h10v9H3V4zm2-2v3m6-3v3M3 7h10',
  car: 'M2.5 8l1.3-3.2h8.4L13.5 8v4h-2v-1h-7v1h-2V8zm2 0h7M5 10h.1M11 10h.1',
  invoice: 'M4 2.5h6l2 2V14H4V2.5zm5.8 0v2.2H12M6 7h4M6 9.5h4M6 12h2.5',
  box: 'M3 5l5-2 5 2v6l-5 2-5-2V5zm0 0 5 2 5-2M8 7v6',
  wrench: 'M10.8 2.5a3.1 3.1 0 01-3.7 4.1L3.5 10.2a1.4 1.4 0 102 2l3.6-3.6a3.1 3.1 0 004.1-3.7l-2 2-1.8-1.8 2-2z',
  message: 'M2.5 4.2h11v7h-6.8L3 13.8v-2.6h-.5v-7zm2.2 2.3h6.6M4.7 8.9h4.5',
  edit: 'M3 11.8l2.8-.6L12 5l-2-2-6.2 6.2L3 11.8zm5.6-7.4 2 2',
  pause: 'M5 3.5v9M11 3.5v9',
  play: 'M5 3.5l7 4.5-7 4.5v-9z',
  more: 'M8 3.2v.1M8 8v.1M8 12.8v.1',
};

function uiIcon(name, className = 'ui-icon') {
  const path = UI_ICON_PATHS[name] || UI_ICON_PATHS.more;
  return `<svg class="${className}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"></path></svg>`;
}

function getToneFromText(text) {
  const tones = ['blue', 'green', 'amber', 'purple', 'rose', 'mint'];
  const raw = String(text || 'x');
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) hash = ((hash << 5) - hash) + raw.charCodeAt(i);
  return tones[Math.abs(hash) % tones.length];
}

function renderEntityAvatar(label, key = label) {
  return `<div class="entity-avatar tone-${getToneFromText(key)}">${escHtml(initials(label || '?'))}</div>`;
}

function renderEntityCell({ label, meta = '', avatarKey = label }) {
  return `
    <div class="entity-cell">
      ${renderEntityAvatar(label, avatarKey)}
      <div class="entity-main">
        <div class="entity-title">${escHtml(label || '-')}</div>
        ${meta ? `<div class="entity-subtitle">${escHtml(meta)}</div>` : ''}
      </div>
    </div>
  `;
}

function renderIconMeta(icon, value, empty = '-') {
  const isEmpty = value === undefined || value === null || String(value).trim() === '';
  return `<div class="icon-meta ${isEmpty ? 'is-muted' : ''}">${uiIcon(icon)}<span>${escHtml(isEmpty ? empty : value)}</span></div>`;
}

function renderContactCell(phone, email) {
  return `<div class="contact-stack">${renderIconMeta('phone', phone, 'No phone')}${renderIconMeta('mail', email, 'No email')}</div>`;
}

function formatRelativeDays(dateValue) {
  if (!dateValue) return '';
  const date = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((startToday - startDate) / (24 * 60 * 60 * 1000));
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return `${diffDays} days ago`;
}

function renderDateCell(dateValue, empty = 'No visits yet') {
  if (!dateValue) {
    return `<div class="date-cell muted">${renderIconMeta('calendar', empty, empty)}<div class="entity-subtitle">-</div></div>`;
  }
  return `<div class="date-cell">${renderIconMeta('calendar', fmtDate(dateValue))}<div class="entity-subtitle">${escHtml(formatRelativeDays(dateValue))}</div></div>`;
}

function renderRegChip(registration) {
  return `<span class="reg-chip">${escHtml(registration || '-')}</span>`;
}

function getVehicleTitle(vehicle) {
  return [vehicle?.make, vehicle?.model].filter(Boolean).join(' ').trim() || 'Vehicle';
}

function renderVehicleStack({ make = '', model = '', registration = '', meta = '' } = {}) {
  const title = [make, model].filter(Boolean).join(' ').trim() || 'Vehicle';
  return `
    <div class="vehicle-stack">
      <div class="vehicle-title">${escHtml(title)}</div>
      <div class="vehicle-meta">${renderRegChip(registration)}${meta ? `<span class="entity-subtitle">${escHtml(meta)}</span>` : ''}</div>
    </div>
  `;
}

function renderOpenAction(onClick, label = 'Open') {
  return `<button class="row-open-btn" onclick="event.stopPropagation();${onClick}">${escHtml(label)}</button>`;
}

function renderMoreAction(onClick, label = 'More actions') {
  return `<button class="row-more-btn" title="${escHtml(label)}" onclick="event.stopPropagation();${onClick}">${uiIcon('more')}</button>`;
}

function renderRowActions(primaryOnClick, moreOnClick = '', label = 'More actions') {
  return `<div class="row-actions">${renderMoreAction(moreOnClick || primaryOnClick, label)}</div>`;
}

function isInteractiveClickTarget(target) {
  return Boolean(target?.closest?.('button, a, input, select, textarea, label, [contenteditable="true"], .row-actions'));
}

function getSelectedText() {
  try {
    return String(window.getSelection?.().toString() || '').trim();
  } catch {
    return '';
  }
}

function handleClickablePointerDown(event) {
  const row = event.target?.closest?.('.clickable');
  if (!row || isInteractiveClickTarget(event.target)) {
    clickablePointerState = null;
    return;
  }
  clickablePointerState = {
    x: event.clientX,
    y: event.clientY,
    row,
  };
}

function shouldBlockClickableRow(event) {
  const row = event.target?.closest?.('.clickable');
  if (!row || isInteractiveClickTarget(event.target)) return false;
  if (getSelectedText()) return true;
  if (!clickablePointerState || clickablePointerState.row !== row) return false;
  const dx = Math.abs(event.clientX - clickablePointerState.x);
  const dy = Math.abs(event.clientY - clickablePointerState.y);
  return dx > 6 || dy > 6;
}

function guardClickableRowClick(event) {
  if (!shouldBlockClickableRow(event)) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
  clickablePointerState = null;
}

function renderTableFooter(count, label, total = count) {
  const visible = Number(count) || 0;
  const all = Number(total) || visible;
  const start = visible ? 1 : 0;
  return `
    <div class="table-footer">
      <span>Showing ${start} to ${visible} of ${all} ${escHtml(label)}</span>
      <div class="table-pager">
        <button class="pager-btn" disabled>&lsaquo;</button>
        <button class="pager-btn active">1</button>
        <button class="pager-btn" disabled>&rsaquo;</button>
      </div>
    </div>
  `;
}

function renderEmptyTableRow(colspan, message) {
  return `<tr><td colspan="${colspan}" class="empty-table-cell">${escHtml(message)}</td></tr>`;
}

function getTableSort(tableKey) {
  const sort = (state.sorts && state.sorts[tableKey]) || {};
  return {
    key: String(sort.key || ''),
    dir: sort.dir === 'desc' ? 'desc' : 'asc',
  };
}

function setTableSort(tableKey, key) {
  if (!state.sorts) state.sorts = {};
  const current = getTableSort(tableKey);
  state.sorts[tableKey] = {
    key,
    dir: current.key === key && current.dir === 'asc' ? 'desc' : 'asc',
  };
  renderInPlace();
}

function compareSortValues(a, b) {
  const aEmpty = a === undefined || a === null || a === '';
  const bEmpty = b === undefined || b === null || b === '';
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  const aNumber = Number(a);
  const bNumber = Number(b);
  if (Number.isFinite(aNumber) && Number.isFinite(bNumber) && String(a).trim() !== '' && String(b).trim() !== '') {
    return aNumber - bNumber;
  }
  return String(a).toLowerCase().localeCompare(String(b).toLowerCase(), undefined, { numeric: true, sensitivity: 'base' });
}

function sortRows(rows, tableKey, columns) {
  const { key, dir } = getTableSort(tableKey);
  const getter = columns[key];
  if (!getter) return rows;
  const multiplier = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => compareSortValues(getter(a), getter(b)) * multiplier);
}

function SortableTh(tableKey, key, label, className = '') {
  const sort = getTableSort(tableKey);
  const active = sort.key === key;
  const indicator = active ? (sort.dir === 'asc' ? '&uarr;' : '&darr;') : '';
  return `<th class="sortable-th ${active ? 'is-active' : ''} ${className}" onclick="setTableSort('${tableKey}','${key}')"><button type="button" class="sort-btn"><span>${escHtml(label)}</span><span class="sort-indicator">${indicator}</span></button></th>`;
}

function normalizeInventoryFilter(filter) {
  return ['all', 'low', 'out'].includes(filter) ? filter : 'all';
}

function getInventoryItems() {
  return Array.isArray(state.inventoryItems) ? state.inventoryItems : [];
}

function getInventoryMovements() {
  return Array.isArray(state.inventoryMovements) ? state.inventoryMovements : [];
}

function getInventoryItemById(itemId) {
  const numericId = Number(itemId);
  return getInventoryItems().find(item => Number(item.id) === numericId) || null;
}

function getInventoryPartName(item) {
  return item?.part_name || item?.partName || item?.name || 'Part';
}

function getInventorySku(item) {
  return item?.sku || item?.SKU || '—';
}

function getInventorySupplier(item) {
  return item?.supplier || item?.supplier_name || item?.supplierName || '—';
}

function getInventoryQuantity(item) {
  return Number(item?.quantity ?? item?.currentStock ?? item?.current_stock ?? item?.stock ?? 0) || 0;
}

function getInventoryMinimumStockLevel(item) {
  return Number(item?.minimum_stock_level ?? item?.minimumStockLevel ?? item?.reorderLevel ?? item?.reorder_level ?? 0) || 0;
}

function getInventoryPurchaseCost(item) {
  return Number(item?.purchase_cost ?? item?.purchaseCost ?? item?.unit_cost ?? item?.cost ?? 0) || 0;
}

function roundInventoryMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function getFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function calculateInventorySellPrice(purchaseCost, marginPercent) {
  return roundInventoryMoney(getFiniteNumber(purchaseCost) * (1 + (getFiniteNumber(marginPercent) / 100)));
}

function calculateInventoryMarginPercent(purchaseCost, sellPrice) {
  const cost = getFiniteNumber(purchaseCost);
  if (cost <= 0) return 0;
  return Math.round((((getFiniteNumber(sellPrice) - cost) / cost) * 100) * 100) / 100;
}

function getInventoryPriceMode(item) {
  return String(item?.price_mode ?? item?.priceMode ?? 'auto').toLowerCase() === 'manual' ? 'manual' : 'auto';
}

function getInventoryMarginPercent(item) {
  const storedMargin = item?.margin_percent ?? item?.marginPercent;
  if (storedMargin !== undefined && storedMargin !== null && storedMargin !== '') return Number(storedMargin) || 0;
  const rawSellPrice = Number(item?.sell_price ?? item?.sellPrice ?? item?.retail_price ?? item?.retailPrice ?? 0) || 0;
  return calculateInventoryMarginPercent(getInventoryPurchaseCost(item), rawSellPrice);
}

function getInventorySellPrice(item) {
  const rawSellPrice = Number(item?.sell_price ?? item?.sellPrice ?? item?.retail_price ?? item?.retailPrice ?? 0) || 0;
  if (getInventoryPriceMode(item) === 'auto' && rawSellPrice <= 0) {
    const marginPercent = Number(item?.margin_percent ?? item?.marginPercent ?? 0) || 0;
    return calculateInventorySellPrice(getInventoryPurchaseCost(item), marginPercent);
  }
  return rawSellPrice;
}

function getInventoryValue(item) {
  return getInventoryQuantity(item) * getInventoryPurchaseCost(item);
}

function getInventoryRetailValue(item) {
  return getInventoryQuantity(item) * getInventorySellPrice(item);
}

function getInventoryStockStatus(item) {
  const quantity = getInventoryQuantity(item);
  if (quantity <= 0) return 'Critical';
  return quantity <= getInventoryMinimumStockLevel(item) ? 'Low' : 'Good';
}

function getLineInventoryItem(line) {
  const itemId = Number(line?.inventory_item_id || 0);
  return itemId ? getInventoryItemById(itemId) : null;
}

function isPlaceholderDash(value) {
  const text = String(value || '');
  return text === '\u2014' || text === 'â€”';
}

function getLineInventoryField(line, field, fallback = '') {
  const directValue = line?.[`inventory_${field}`];
  if (directValue !== undefined && directValue !== null && directValue !== '') return directValue;
  const item = getLineInventoryItem(line);
  if (!item) return fallback;
  if (field === 'part_name') return getInventoryPartName(item);
  if (field === 'sku') return getInventorySku(item);
  if (field === 'supplier') return getInventorySupplier(item);
  if (field === 'category') return item.category || fallback;
  return fallback;
}

function getLineInventorySnapshot(item) {
  return item ? {
    inventory_part_name: getInventoryPartName(item),
    inventory_sku: getInventorySku(item),
    inventory_category: item.category || '',
    inventory_supplier: getInventorySupplier(item),
  } : {
    inventory_part_name: '',
    inventory_sku: '',
    inventory_category: '',
    inventory_supplier: '',
  };
}

function getInventoryLineSearchText(item) {
  return [
    getInventoryPartName(item),
    getInventorySku(item),
    item?.category || '',
    getInventorySupplier(item),
    item?.notes || '',
  ].join(' ').toLowerCase();
}

function getInventoryLinePickerLabel(item) {
  if (!item) return '';
  const sku = getInventorySku(item);
  return [getInventoryPartName(item), sku && !isPlaceholderDash(sku) ? sku : ''].filter(Boolean).join(' | ');
}

function searchInventoryLineItems(query, limit = 8) {
  const tokens = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  return getInventoryItems()
    .filter(item => {
      const haystack = getInventoryLineSearchText(item);
      return tokens.every(token => haystack.includes(token));
    })
    .sort((a, b) => {
      const qa = String(query || '').trim().toLowerCase();
      const aName = getInventoryPartName(a).toLowerCase();
      const bName = getInventoryPartName(b).toLowerCase();
      const aSku = getInventorySku(a).toLowerCase();
      const bSku = getInventorySku(b).toLowerCase();
      const aScore = (aName.startsWith(qa) ? 0 : aSku.startsWith(qa) ? 1 : 2);
      const bScore = (bName.startsWith(qa) ? 0 : bSku.startsWith(qa) ? 1 : 2);
      return aScore - bScore
        || aName.localeCompare(bName, undefined, { sensitivity: 'base' })
        || aSku.localeCompare(bSku, undefined, { sensitivity: 'base' });
    })
    .slice(0, limit);
}

function getInventoryLineSearchChoices(lineId, query) {
  const results = searchInventoryLineItems(query);
  const line = state.jobLines.find(item => item.id === lineId) || state.invoiceLines.find(item => item.id === lineId);
  const hasLinkedItem = Boolean(Number(line?.inventory_item_id || 0));
  const choices = results.map(item => ({ kind: 'item', item }));
  if (hasLinkedItem) choices.push({ kind: 'manual', item: null });
  return choices;
}

function renderInventoryLineSearchResults(lineId, query, activeIndex = 0) {
  const choices = getInventoryLineSearchChoices(lineId, query);
  if (!String(query || '').trim()) {
    return `${choices.some(choice => choice.kind === 'manual') ? `<button type="button" class="line-inventory-result is-clear ${activeIndex === 0 ? 'active' : ''}" data-inventory-choice="" onclick="applyInventoryToLine(${lineId}, '')">Manual line</button>` : ''}<div class="line-inventory-empty">Type part name, SKU, category or supplier</div>`;
  }
  if (!choices.length || !choices.some(choice => choice.kind === 'item')) {
    return `${choices.some(choice => choice.kind === 'manual') ? `<button type="button" class="line-inventory-result is-clear ${activeIndex === 0 ? 'active' : ''}" data-inventory-choice="" onclick="applyInventoryToLine(${lineId}, '')">Manual line</button>` : ''}<div class="line-inventory-empty">No matching inventory items</div>`;
  }
  return choices.map((choice, index) => {
    if (choice.kind === 'manual') {
      return `<button type="button" class="line-inventory-result is-clear ${activeIndex === index ? 'active' : ''}" data-inventory-choice="" onclick="applyInventoryToLine(${lineId}, '')">Manual line</button>`;
    }
    const item = choice.item;
    const sku = getInventorySku(item);
    const supplier = getInventorySupplier(item);
    const meta = [
      sku && !isPlaceholderDash(sku) ? `SKU ${sku}` : '',
      supplier && !isPlaceholderDash(supplier) ? supplier : '',
      `${fmtQty(getInventoryQuantity(item))} in stock`,
      fmt(getInventorySellPrice(item)),
    ].filter(Boolean).join(' | ');
    return `
      <button type="button" class="line-inventory-result ${activeIndex === index ? 'active' : ''}" data-inventory-choice="${Number(item.id) || 0}" onclick="applyInventoryToLine(${lineId}, ${Number(item.id) || 0})">
        <span>${escHtml(getInventoryPartName(item))}</span>
        <small>${escHtml(meta)}</small>
      </button>
    `;
  }).join('');
}

function updateInventoryLineSearch(lineId, query, activeIndex = 0) {
  const menu = document.getElementById(`job-line-${lineId}-inventory-menu`);
  if (!menu) return;
  const choices = getInventoryLineSearchChoices(lineId, query);
  const maxIndex = Math.max(0, choices.length - 1);
  const nextIndex = Math.max(0, Math.min(activeIndex, maxIndex));
  menu.dataset.activeIndex = String(nextIndex);
  menu.dataset.query = String(query || '');
  menu.innerHTML = renderInventoryLineSearchResults(lineId, query, nextIndex);
  menu.classList.add('open');
}

function closeInventoryLineSearch(lineId) {
  const menu = document.getElementById(`job-line-${lineId}-inventory-menu`);
  if (menu) menu.classList.remove('open');
}

function chooseInventoryLineSearch(lineId, query, activeIndex = 0, focusNext = false) {
  const hasQuery = Boolean(String(query || '').trim());
  const choices = getInventoryLineSearchChoices(lineId, query).filter(choice => {
    if (hasQuery) return true;
    return choice.kind === 'manual';
  });
  if (hasQuery && !choices.some(choice => choice.kind === 'item')) return false;
  if (!choices.length) return false;
  const choice = choices[Math.max(0, Math.min(activeIndex, choices.length - 1))] || choices[0];
  applyInventoryToLine(lineId, choice.kind === 'manual' ? '' : choice.item.id, { focusNext });
  return true;
}

function handleInventoryLineSearchKey(event, lineId) {
  const menu = document.getElementById(`job-line-${lineId}-inventory-menu`);
  const query = event.currentTarget.value;
  const choices = getInventoryLineSearchChoices(lineId, query);
  const currentIndex = Number(menu?.dataset.activeIndex || 0) || 0;
  if (event.key === 'Escape') {
    closeInventoryLineSearch(lineId);
    event.currentTarget.blur();
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    updateInventoryLineSearch(lineId, query, choices.length ? (currentIndex + 1) % choices.length : 0);
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    updateInventoryLineSearch(lineId, query, choices.length ? (currentIndex - 1 + choices.length) % choices.length : 0);
    return;
  }
  if (event.key !== 'Enter' && event.key !== 'Tab') return;
  const picked = chooseInventoryLineSearch(lineId, query, currentIndex, true);
  if (picked) event.preventDefault();
}

function renderInventoryLineSelect(line) {
  const item = getLineInventoryItem(line);
  const label = getInventoryLinePickerLabel(item);
  return `
    <div class="line-inventory-picker">
      <input
        id="job-line-${line.id}-inventory_item_id"
        type="text"
        value="${escHtml(label)}"
        placeholder="Manual line"
        autocomplete="off"
        onfocus="updateInventoryLineSearch(${line.id}, this.value)"
        oninput="updateInventoryLineSearch(${line.id}, this.value)"
        onkeydown="handleInventoryLineSearchKey(event, ${line.id})"
        onblur="setTimeout(() => closeInventoryLineSearch(${line.id}), 140)"
      />
      <div id="job-line-${line.id}-inventory-menu" class="line-inventory-menu"></div>
    </div>
  `;
}

function renderLineInventorySummary(line) {
  if (!Number(line?.inventory_item_id || 0)) return '';
  const sku = getLineInventoryField(line, 'sku', '');
  const supplier = getLineInventoryField(line, 'supplier', '');
  const meta = [sku && !isPlaceholderDash(sku) ? `SKU ${sku}` : '', supplier && !isPlaceholderDash(supplier) ? supplier : ''].filter(Boolean).join(' | ');
  return meta ? `<div class="line-inventory-meta">${escHtml(meta)}</div>` : '';
}

function renderPrintLineDescription(line) {
  const inventoryName = getLineInventoryField(line, 'part_name', '');
  const description = String(line?.description || '').trim();
  const title = inventoryName || description || line?.line_type || 'Line item';
  const details = [];
  if (inventoryName && description && description.toLowerCase() !== inventoryName.toLowerCase()) details.push(description);
  const sku = getLineInventoryField(line, 'sku', '');
  const supplier = getLineInventoryField(line, 'supplier', '');
  if (sku && !isPlaceholderDash(sku)) details.push(`SKU ${sku}`);
  if (supplier && !isPlaceholderDash(supplier)) details.push(supplier);
  return `<div>${escHtml(title)}</div>${details.length ? `<div class="invoice-sheet-line-meta">${escHtml(details.join(' | '))}</div>` : ''}`;
}

function getTotalInventoryItems(items = getInventoryItems()) {
  return items.length;
}

function getLowStockItems(items = getInventoryItems()) {
  return items.filter(item => getInventoryQuantity(item) <= getInventoryMinimumStockLevel(item));
}

function getOutOfStockItems(items = getInventoryItems()) {
  return items.filter(item => getInventoryQuantity(item) === 0);
}

function getTotalInventoryValue(items = getInventoryItems()) {
  return items.reduce((sum, item) => sum + getInventoryValue(item), 0);
}

function getRecentInventoryMovements(movements = getInventoryMovements(), limit = 5) {
  return [...movements]
    .sort((a, b) => {
      const dateCompare = String(b.movement_date || b.date || '').localeCompare(String(a.movement_date || a.date || ''));
      return dateCompare || (Number(b.id) || 0) - (Number(a.id) || 0);
    })
    .slice(0, limit);
}

function formatInventoryMovementQuantity(movement) {
  const quantity = Number(movement?.quantity || 0);
  if (movement?.movement_type === 'Adjustment' && quantity > 0) return `+${fmtQty(quantity)}`;
  return fmtQty(quantity);
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = translateToastMessage(msg); t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

function renderVehicleVinInline(vehicle) {
  const vin = String(vehicle?.vin || '').trim();
  if (!vin) return '';
  return `
    <div class="vehicle-vin-inline">
      <span>VIN: ${escHtml(vin)}</span>
      <button class="copy-icon-btn" type="button" data-vin="${escHtml(vin)}" onclick="copyVehicleVin(this)" title="Copy VIN" aria-label="Copy VIN">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M5.5 5.5h7v8h-7z"></path>
          <path d="M3.5 10.5h-1v-8h7v1"></path>
        </svg>
      </button>
    </div>
  `;
}

function snapshotActiveField(root = document) {
  const active = document.activeElement;
  if (!active) return null;
  if (root && root !== document && !root.contains(active)) return null;
  const id = active.id || null;
  if (!id) return null;
  return {
    id,
    value: typeof active.value === 'string' ? active.value : null,
    selectionStart: typeof active.selectionStart === 'number' ? active.selectionStart : null,
    selectionEnd: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
    interactionSerial: state.userInteractionSerial,
  };
}

function restoreActiveField(snapshot) {
  if (!snapshot?.id) return false;
  if ((snapshot.interactionSerial ?? 0) !== state.userInteractionSerial) return false;
  const next = document.getElementById(snapshot.id);
  if (!next) return false;
  if (snapshot.value !== null && typeof next.value === 'string' && next.value !== snapshot.value) {
    next.value = snapshot.value;
  }
  next.focus();
  if (snapshot.value !== null && typeof next.value === 'string') {
    const pos = Math.min(snapshot.value.length, next.value.length);
    if (snapshot.selectionStart !== null && snapshot.selectionEnd !== null && typeof next.setSelectionRange === 'function') {
      next.setSelectionRange(Math.min(snapshot.selectionStart, pos), Math.min(snapshot.selectionEnd, pos));
    }
  }
  return true;
}

function restorePersistentModal() {
  if (document.getElementById('modal-overlay') || !state.modalState) return;
  if (state.modalState.kind === 'client') {
    const clientId = state.modalState.clientId || null;
    if (clientId && !state.clients.some(client => client.id === clientId)) {
      state.modalState = null;
      return;
    }
    showClientModal(clientId, { persist: false });
    return;
  }
  if (state.modalState.kind === 'vehicle') {
    const vehicleId = state.modalState.vehicleId || null;
    if (vehicleId && !state.vehicles.some(vehicle => vehicle.id === vehicleId)) {
      state.modalState = null;
      return;
    }
    showVehicleModal(vehicleId, state.modalState.presetClientId || null, { persist: false });
    return;
  }
  if (state.modalState.kind === 'inventory-item') {
    const itemId = state.modalState.itemId || null;
    if (itemId && !getInventoryItemById(itemId)) {
      state.modalState = null;
      return;
    }
    showInventoryItemModal(itemId, { persist: false });
    return;
  }
  if (state.modalState.kind === 'inventory-movement') {
    const itemId = state.modalState.itemId || null;
    if (!itemId || !getInventoryItemById(itemId)) {
      state.modalState = null;
      return;
    }
    showInventoryMovementModal(itemId, state.modalState.movementType || 'Stock In', { persist: false });
  }
}

function applyPendingFocus() {
  const pendingFocusId = state.pendingFocusId;
  const shouldSelectAll = Boolean(state.pendingFocusSelectAll);
  const pendingFocusSerial = state.pendingFocusSerial;
  state.pendingFocusId = null;
  state.pendingFocusSelectAll = false;
  state.pendingFocusSerial = 0;
  if (!pendingFocusId) return;
  if (pendingFocusSerial !== state.userInteractionSerial) return;
  const target = document.getElementById(pendingFocusId);
  if (!target) return;
  target.focus();
  if (typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ block: 'nearest' });
  }
  if (shouldSelectAll && typeof target.select === 'function') {
    target.select();
  }
}

function clearZeroNumberInput(input) {
  if (!input) return;
  const rawValue = String(input.value ?? '').trim();
  if (!rawValue) return;
  const numericValue = Number(rawValue);
  if (!Number.isNaN(numericValue) && numericValue === 0) {
    input.value = '';
  }
}

function normalizeLineStatus(value) {
  return String(value || '').trim().toLowerCase() === 'pending' ? 'pending' : 'confirmed';
}

function isLinePending(line) {
  return normalizeLineStatus(line?.line_status) === 'pending';
}

const LINE_TYPES = ['Part', 'Labour', 'Other'];
const DEFAULT_LINE_TYPE = 'Part';
const PENDING_LINE_CONFIRM_STATUSES = new Set(['Ready', 'Completed']);
const JOB_STATUS_FILTERS = ['active', 'completed', 'all'];
const JOB_LINE_SORT_FIELDS = ['type', 'description', 'qty', 'unit', 'total'];

function renderLineTypeOptions(selectedType) {
  return LINE_TYPES.map(type => `<option ${selectedType === type ? 'selected' : ''}>${type}</option>`).join('');
}

function getLineDescriptionFilterText(line) {
  return [
    line?.description,
    getLineInventoryField(line, 'part_name', ''),
    getLineInventoryField(line, 'sku', ''),
    getLineInventoryField(line, 'supplier', ''),
  ].filter(Boolean).join(' ').toLowerCase();
}

function getJobLineSort() {
  state.jobLineSort = {
    field: '',
    direction: 'asc',
    ...(state.jobLineSort || {}),
  };
  if (!JOB_LINE_SORT_FIELDS.includes(state.jobLineSort.field)) {
    state.jobLineSort.field = '';
  }
  state.jobLineSort.direction = state.jobLineSort.direction === 'desc' ? 'desc' : 'asc';
  return state.jobLineSort;
}

function getJobLineSortValue(line, field) {
  const selectedType = LINE_TYPES.includes(line?.line_type) ? line.line_type : DEFAULT_LINE_TYPE;
  const qty = Number(line?.qty) || 0;
  const unit = Number(line?.unit_price) || 0;
  if (field === 'type') return LINE_TYPES.indexOf(selectedType);
  if (field === 'description') return getLineDescriptionFilterText(line);
  if (field === 'qty') return qty;
  if (field === 'unit') return unit;
  if (field === 'total') return qty * unit;
  return '';
}

function sortJobLinesForEditor(lines) {
  const sort = getJobLineSort();
  if (!sort.field) return lines;
  const direction = sort.direction === 'desc' ? -1 : 1;
  return lines.map((line, index) => ({ line, index })).sort((left, right) => {
    const leftValue = getJobLineSortValue(left.line, sort.field);
    const rightValue = getJobLineSortValue(right.line, sort.field);
    const result = typeof leftValue === 'number' && typeof rightValue === 'number'
      ? leftValue - rightValue
      : String(leftValue || '').localeCompare(String(rightValue || ''), undefined, { numeric: true, sensitivity: 'base' });
    return result === 0 ? left.index - right.index : result * direction;
  }).map(item => item.line);
}

function toggleJobLineSort(field) {
  if (!JOB_LINE_SORT_FIELDS.includes(field)) return;
  const sort = getJobLineSort();
  if (sort.field === field) {
    sort.direction = sort.direction === 'asc' ? 'desc' : 'asc';
  } else {
    sort.field = field;
    sort.direction = 'asc';
  }
  void renderInPlace();
}

function renderJobLineHeaderButton(field, label) {
  const sort = getJobLineSort();
  const active = sort.field === field;
  const arrow = active ? (sort.direction === 'asc' ? '↑' : '↓') : '';
  return `
    <button type="button" class="line-editor-header-btn ${active ? 'active' : ''}" title="Sort by ${escHtml(label)}" onclick="toggleJobLineSort('${field}')">
      <span>${escHtml(label)}</span>${arrow ? `<strong>${arrow}</strong>` : ''}
    </button>
  `;
}

function renderLineTypeControl(line) {
  const selectedType = LINE_TYPES.includes(line?.line_type) ? line.line_type : DEFAULT_LINE_TYPE;
  return `<select id="job-line-${line.id}-line_type" class="line-type-select line-type-${selectedType.toLowerCase()}" onchange="setLineType(${line.id}, this.value)">${renderLineTypeOptions(selectedType)}</select>`;
}

function normalizeWorkerId(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : null;
}

function normalizeWorkerPercent(value, fallback = 30) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(100, Math.round(numeric * 100) / 100));
}

function getWorkerById(workerId) {
  const id = normalizeWorkerId(workerId);
  if (!id) return null;
  return (state.workers || []).find(worker => normalizeWorkerId(worker.id) === id) || null;
}

function getWorkerDisplayName(worker) {
  const name = [worker?.first_name, worker?.last_name].map(part => String(part || '').trim()).filter(Boolean).join(' ');
  return name || worker?.name || 'Worker';
}

function getWorkerInitials(worker) {
  return initials(getWorkerDisplayName(worker));
}

function getActiveWorkers() {
  return (state.workers || [])
    .filter(worker => worker && worker.active !== false)
    .sort((a, b) => getWorkerDisplayName(a).localeCompare(getWorkerDisplayName(b)));
}

function renderWorkerSelectOptions(selectedWorkerId) {
  const selectedId = normalizeWorkerId(selectedWorkerId);
  const workers = getActiveWorkers();
  const selectedWorker = selectedId ? getWorkerById(selectedId) : null;
  const options = [
    `<option value="" ${selectedId ? '' : 'selected'}>Unassigned</option>`,
    ...workers.map(worker => {
      const id = normalizeWorkerId(worker.id);
      return `<option value="${id}" ${selectedId === id ? 'selected' : ''}>${escHtml(getWorkerDisplayName(worker))}</option>`;
    }),
  ];
  if (selectedWorker && selectedWorker.active === false) {
    options.push(`<option value="${selectedId}" selected>${escHtml(getWorkerDisplayName(selectedWorker))} (inactive)</option>`);
  }
  return options.join('');
}

function renderLineWorkerControl(line) {
  const workers = state.workers || [];
  if (!workers.length) {
    return `<select id="job-line-${line.id}-worker_id" class="line-worker-select" disabled><option>No workers</option></select>`;
  }
  return `<select id="job-line-${line.id}-worker_id" class="line-worker-select" onchange="updateLine(${line.id},'worker_id',this.value)">${renderWorkerSelectOptions(line?.worker_id)}</select>`;
}

function previewLineNumberInput(lineId) {
  const qtyInput = document.getElementById(`job-line-${lineId}-qty`);
  const unitInput = document.getElementById(`job-line-${lineId}-unit_price`);
  const totalCell = document.getElementById(`job-line-${lineId}-total`);
  if (!qtyInput || !unitInput) return;
  const qty = parseFloat(qtyInput.value) || 0;
  const unitPrice = parseFloat(unitInput.value) || 0;
  if (totalCell) totalCell.textContent = fmt(qty * unitPrice);
  previewLineTotalsFromInputs();
}

function previewLineTotalsFromInputs() {
  const rows = Array.from(document.querySelectorAll('[data-line-id]'));
  if (!rows.length) return;
  const breakdown = { labour: 0, parts: 0, other: 0 };
  const subtotal = roundMoney(rows.reduce((sum, row) => {
    const lineId = row.dataset.lineId;
    const qty = parseFloat(document.getElementById(`job-line-${lineId}-qty`)?.value) || 0;
    const unitPrice = parseFloat(document.getElementById(`job-line-${lineId}-unit_price`)?.value) || 0;
    const lineType = document.getElementById(`job-line-${lineId}-line_type`)?.value || getLineById(lineId)?.line_type || DEFAULT_LINE_TYPE;
    const lineTotal = qty * unitPrice;
    breakdown[getLineBreakdownKey(lineType)] += lineTotal;
    return sum + lineTotal;
  }, 0));
  const vatRate = getAppliedVatRate();
  const vat = roundMoney(getVatAmount(subtotal, vatRate));
  const total = roundMoney(subtotal + vat);
  const roundedBreakdown = {
    labour: roundMoney(breakdown.labour),
    parts: roundMoney(breakdown.parts),
    other: roundMoney(breakdown.other),
  };
  [
    ['job-card-subtotal', subtotal],
    ['invoice-editor-subtotal', subtotal],
    ['job-card-vat', vat],
    ['invoice-editor-vat', vat],
    ['job-card-total', total],
    ['invoice-editor-total', total],
    ['job-card-labour-total', roundedBreakdown.labour],
    ['job-card-parts-total', roundedBreakdown.parts],
    ['job-card-other-total', roundedBreakdown.other],
    ['invoice-editor-labour-total', roundedBreakdown.labour],
    ['invoice-editor-parts-total', roundedBreakdown.parts],
    ['invoice-editor-other-total', roundedBreakdown.other],
  ].forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = fmt(value);
  });
}

function getLineById(lineId) {
  const id = Number(lineId);
  return state.invoiceLines.find(item => item.id === id) || state.jobLines.find(item => item.id === id) || state.allJobLines.find(item => item.id === id) || null;
}

function mergeAllJobLinesForJob(jobId, lines = []) {
  const numericJobId = Number(jobId);
  state.allJobLines = [
    ...(state.allJobLines || []).filter(line => Number(line.job_id) !== numericJobId),
    ...lines.map(line => ({ ...line })),
  ].sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
}

function getAllJobLinesForJob(jobId) {
  const numericJobId = Number(jobId);
  const all = (state.allJobLines || []).filter(line => Number(line.job_id) === numericJobId);
  if (all.length) return all;
  return (state.jobLines || []).filter(line => Number(line.job_id) === numericJobId);
}

function isLabourLine(line) {
  return String(line?.line_type || '').trim().toLowerCase() === 'labour';
}

function getLineTotal(line) {
  return roundMoney((Number(line?.qty) || 0) * (Number(line?.unit_price) || 0));
}

function buildJobWorkerPayoutRows(lines = []) {
  const map = new Map();
  lines.filter(isLabourLine).forEach(line => {
    const labour = getLineTotal(line);
    if (labour <= 0) return;
    const workerId = normalizeWorkerId(line.worker_id);
    const worker = getWorkerById(workerId);
    const key = worker ? String(worker.id) : 'unassigned';
    if (!map.has(key)) {
      const rate = worker ? normalizeWorkerPercent(worker.commission_percent, 0) : 0;
      map.set(key, {
        key,
        worker,
        name: worker ? getWorkerDisplayName(worker) : 'Unassigned',
        role: worker?.position || '-',
        rate,
        labour: 0,
        payout: 0,
        lines: 0,
      });
    }
    const row = map.get(key);
    row.labour = roundMoney(row.labour + labour);
    row.payout = roundMoney(row.payout + (labour * row.rate / 100));
    row.lines += 1;
  });
  return Array.from(map.values()).sort((a, b) => b.payout - a.payout || a.name.localeCompare(b.name));
}

function renderJobWorkerPayoutCard(lines = []) {
  const rows = buildJobWorkerPayoutRows(lines);
  const totalPayout = rows.reduce((sum, row) => sum + row.payout, 0);
  const totalLabour = rows.reduce((sum, row) => sum + row.labour, 0);
  return `
    <div class="card job-worker-card">
      <div class="card-header">
        <span class="card-title">Assigned Workers &amp; Payout</span>
        <span class="badge badge-blue">${fmt(totalLabour)} labour</span>
      </div>
      ${rows.length ? `
        <div class="table-scroll">
          <table class="data-table job-worker-table">
            <thead><tr><th>Worker</th><th>Role</th><th>Labour</th><th>Rate</th><th>Payout</th></tr></thead>
            <tbody>
              ${rows.map(row => `
                <tr>
                  <td>
                    <div class="worker-cell">
                      <span class="worker-avatar">${escHtml(row.worker ? getWorkerInitials(row.worker) : '?')}</span>
                      <div><strong>${escHtml(row.name)}</strong><div class="entity-subtitle">${row.lines} labour line${row.lines === 1 ? '' : 's'}</div></div>
                    </div>
                  </td>
                  <td>${escHtml(row.role)}</td>
                  <td>${fmt(row.labour)}</td>
                  <td>${row.worker ? fmtPercent(row.rate) : '-'}</td>
                  <td><strong>${fmt(row.payout)}</strong></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <div class="job-worker-total"><span>Total payout</span><strong>${fmt(totalPayout)}</strong></div>
      ` : '<div class="dashboard-empty-state">Assign workers to labour lines to calculate payout.</div>'}
    </div>
  `;
}

function focusLineQty(lineId) {
  setTimeout(() => {
    const qtyInput = document.getElementById(`job-line-${lineId}-qty`);
    if (!qtyInput) return;
    qtyInput.focus();
    if (typeof qtyInput.select === 'function') qtyInput.select();
  }, 0);
}

function replaceLineEditorRow(lineId, { focusQty = false } = {}) {
  const line = getLineById(lineId);
  if (!line) return;
  const row = document.querySelector(`[data-line-id="${lineId}"]`);
  if (!row) return;
  row.outerHTML = renderEditableLineRow(line, line.job_id);
  previewLineTotalsFromInputs();
  if (focusQty) focusLineQty(lineId);
}

function normalizeJobStatusFilter(filter) {
  return JOB_STATUS_FILTERS.includes(filter) ? filter : 'active';
}

function isCompletedJob(job) {
  return String(job?.status || '').trim() === 'Completed';
}

async function confirmPendingLinesBeforeStatusChange(jobId, status) {
  if (!PENDING_LINE_CONFIRM_STATUSES.has(status)) return true;
  const lines = await invoke('get_job_lines', { jobId });
  if (!lines.some(isLinePending)) return true;
  return confirm('This job has pending lines. Are you sure you want to continue?');
}

function renderLineStatusIcon(status) {
  if (normalizeLineStatus(status) === 'pending') {
    return `
      <svg viewBox="0 0 16 16" aria-hidden="true" fill="none">
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.4"></circle>
        <path d="M8 5.1v3.2l2.2 1.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"></path>
      </svg>
    `;
  }
  return `
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="none">
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.4"></circle>
      <path d="M5.1 8.3 7 10.2 10.9 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>
  `;
}

function renderLineInventoryControl(line) {
  if (!isInventoryEnabled()) return '';
  if (String(line?.line_type || DEFAULT_LINE_TYPE) !== 'Part') {
    return `<input class="line-inventory-disabled" type="text" value="" placeholder="Parts search only" disabled />`;
  }
  return renderInventoryLineSelect(line);
}

function renderEditableLineRow(line, jobId) {
  const lineId = Number(line.id) || 0;
  const lineTotal = (Number(line.qty) || 0) * (Number(line.unit_price) || 0);
  const inventoryEnabled = isInventoryEnabled();
  return `
    <div
      class="line-editor-row ${isLinePending(line) ? 'line-row-pending' : ''}"
      data-line-id="${lineId}"
    >
      <div class="line-field line-field-type">
        ${renderLineTypeControl(line)}
      </div>
      ${inventoryEnabled ? `
      <div class="line-field line-field-inventory">
        ${renderLineInventoryControl(line)}
      </div>` : ''}
      <div class="line-field line-field-description">
        <input id="job-line-${lineId}-description" type="text" value="${escHtml(line.description || '')}" placeholder="Optional" onblur="updateLine(${lineId},'description',this.value)" />
        ${inventoryEnabled ? renderLineInventorySummary(line) : ''}
      </div>
      <div class="line-field line-field-qty">
        <input id="job-line-${lineId}-qty" class="number-no-spin" type="number" value="${line.qty}" step="0.5" min="0" onfocus="clearZeroNumberInput(this)" oninput="previewLineNumberInput(${lineId})" onblur="updateLineNum(${lineId},'qty',this.value)" />
      </div>
      <div class="line-field line-field-unit">
        <input id="job-line-${lineId}-unit_price" class="number-no-spin" type="number" value="${line.unit_price}" step="0.01" min="0" onfocus="clearZeroNumberInput(this)" oninput="previewLineNumberInput(${lineId})" onblur="updateLineNum(${lineId},'unit_price',this.value)" onkeydown="handleJobLineUnitPriceEnter(event,${jobId},${lineId})" />
      </div>
      <div class="line-total-box">
        <strong id="job-line-${lineId}-total">${fmt(lineTotal)}</strong>
      </div>
      <div class="line-field line-field-worker">
        ${renderLineWorkerControl(line)}
      </div>
      <div class="line-row-actions">
        <span id="job-line-${lineId}-status-cell" class="line-status-cell">${renderLineStatusToggle(line)}</span>
        <button class="btn btn-sm btn-danger line-delete-btn" onclick="deleteLine(${lineId})">X</button>
      </div>
    </div>
  `;
}

function renderEditableLineEditor(lines, jobId, { filters = false } = {}) {
  if (!lines.length) {
    return '<div class="line-editor-empty">No labour or parts lines yet</div>';
  }
  const inventoryEnabled = isInventoryEnabled();
  const visibleLines = filters ? sortJobLinesForEditor(lines) : lines;
  return `
    <div class="line-editor ${inventoryEnabled ? 'has-inventory' : 'no-inventory'} ${filters ? 'has-sortable-lines' : ''}">
      <div class="line-editor-header">
        ${filters ? renderJobLineHeaderButton('type', 'Type') : '<span>Type</span>'}
        ${inventoryEnabled ? '<span>Inventory</span>' : ''}
        ${filters ? renderJobLineHeaderButton('description', 'Description') : '<span>Description</span>'}
        ${filters ? renderJobLineHeaderButton('qty', 'Qty') : '<span>Qty</span>'}
        ${filters ? renderJobLineHeaderButton('unit', 'Unit price') : '<span>Unit price</span>'}
        ${filters ? renderJobLineHeaderButton('total', 'Total') : '<span>Total</span>'}
        <span>Worker</span>
        <span></span>
      </div>
      ${visibleLines.map(line => renderEditableLineRow(line, jobId)).join('')}
    </div>
  `;
}

function renderJobProfileLayout({ job, client, vehicle, inv, subtotal, vatRate, vat, total }) {
  const showVat = shouldShowInvoiceVat();
  const syncedMileage = getSyncedJobMileage(job, vehicle);
  const lineBreakdown = calculateLineTypeBreakdown(state.jobLines);
  const invoiceTotal = inv ? getInvoiceTotalAmount(inv) : 0;
  const invoicePaidAmount = inv ? getInvoicePaidAmount(inv, invoiceTotal) : 0;
  const invoiceBalanceDue = inv ? getInvoiceBalanceDue(inv, invoiceTotal) : 0;
  const invoiceDisplayStatus = inv ? (invoiceBalanceDue <= 0 ? 'Paid' : (invoicePaidAmount > 0 ? 'Partial' : inv.status)) : '';
  const readySmsEntry = (state.messageLog || []).find(entry => (
    normalizeMessageCategoryKey(entry.category) === 'job_completed'
    && (Number(entry.job_card_id ?? entry.jobCardId ?? 0) === Number(job.id) || (getMessageLogRelatedType(entry) === 'job' && getMessageLogRelatedId(entry) === Number(job.id)))
  ));
  return `
  <button class="btn back-btn" onclick="backToJobs()">&larr; Back to jobs</button>
  <div class="two-col job-detail-layout">
    <div class="job-detail-main">
      <div class="card">
        <div class="card-header"><span class="card-title">Labour &amp; Parts</span><button class="btn btn-sm btn-primary" onclick="addJobLine(${job.id})">+ Add line</button></div>
        ${renderEditableLineEditor(state.jobLines, job.id, { filters: true })}
        <div class="totals-box">
          <div class="total-row"><span class="text-muted">Subtotal</span><span id="job-card-subtotal">${fmt(subtotal)}</span></div>
          ${showVat ? `<div class="total-row"><span class="text-muted">${getVatLabel(vatRate)}</span><span id="job-card-vat">${fmt(vat)}</span></div>` : ''}
          <div class="total-row grand"><span>Total</span><span id="job-card-total">${fmt(total)}</span></div>
          <div class="garage-line-breakdown">
            <div class="garage-line-breakdown-title">Garage breakdown</div>
            <div class="total-row garage-line-breakdown-row"><span>Labour</span><span id="job-card-labour-total">${fmt(lineBreakdown.labour)}</span></div>
            <div class="total-row garage-line-breakdown-row"><span>Parts</span><span id="job-card-parts-total">${fmt(lineBreakdown.parts)}</span></div>
            <div class="total-row garage-line-breakdown-row"><span>Other</span><span id="job-card-other-total">${fmt(lineBreakdown.other)}</span></div>
          </div>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          ${inv ? `<button class="btn btn-primary" onclick="selectInvoice(${inv.id})">View Invoice ${escHtml(inv.invoice_number)}</button>` : `<button class="btn btn-primary" onclick="genInvoice(${job.id})">Generate Invoice</button>`}
          <button class="btn" onclick="updateJobStatus(${job.id},'Ready')">Mark Ready</button>
          <button class="btn" onclick="markJobReadyAndSendSms(${job.id})">Mark Ready &amp; Send SMS</button>
          <button class="btn" onclick="updateJobStatus(${job.id},'Completed')">Mark Complete</button>
          <button class="btn" onclick="showJobCompletedSmsModal(${job.id})">Send ready SMS</button>
        </div>
        <div class="message-action-meta" style="margin-top:10px">
          ${readySmsEntry ? StatusBadge(readySmsEntry.status || 'Draft') : renderPill('Not sent', 'gray')}
          <span class="entity-subtitle">Ready SMS</span>
          ${!formatAmountForSms(total) ? '<span class="entity-subtitle text-red">Amount due is missing</span>' : ''}
        </div>
      </div>
      ${renderJobWorkerPayoutCard(state.jobLines)}
    </div>

    <div class="job-detail-sidebar">
      <div class="card">
        <div class="flex gap-8" style="justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:12px">
          <div><div style="font-size:11px;color:var(--text2)">JOB #${job.id}</div>
          <div style="font-size:16px;font-weight:500">${escHtml(job.registration)} &mdash; ${escHtml(job.make)} ${escHtml(job.model)}</div>
          <div class="text-sm text-muted">${escHtml(job.client_name)} &middot; Opened ${fmtDate(job.date_opened)}</div>
          ${job.booking_id ? `<div class="text-sm text-blue" style="margin-top:4px">From booking ${fmtDate(job.booking_date)} ${escHtml(job.booking_time || '')}</div>` : ''}</div>
          <div style="text-align:right">
            <select onchange="updateJobStatus(${job.id},this.value)" style="font-size:12px;padding:4px 8px;border:0.5px solid var(--border2);border-radius:6px;background:var(--surface);color:var(--text)">
              ${['New','Diagnosing','Waiting Parts','In Progress','Ready','Completed','Cancelled'].map(s=>`<option value="${s}" ${job.status===s?'selected':''}>${s}</option>`).join('')}
            </select>
            <div class="text-sm text-muted" style="margin-top:4px">Mechanic: ${escHtml(job.mechanic||'Unassigned')}</div>
          </div>
        </div>
        <div class="form-grid" style="margin-bottom:12px">
          <div class="form-row"><label>Customer complaint</label><textarea rows="3" onblur="saveJobField(${job.id},'complaint',this.value)">${escHtml(job.complaint||'')}</textarea></div>
          <div class="form-row"><label>Findings / diagnostics</label><textarea rows="3" onblur="saveJobField(${job.id},'findings',this.value)">${escHtml(job.findings||'')}</textarea></div>
          <div class="form-row"><label>Work performed</label><textarea rows="2" onblur="saveJobField(${job.id},'work_performed',this.value)">${escHtml(job.work_performed||'')}</textarea></div>
          <div class="form-row"><label>Mechanic</label><input type="text" value="${escHtml(job.mechanic||'')}" onblur="saveJobField(${job.id},'mechanic',this.value)" /></div>
          <div class="form-row"><label>${getDistanceInLabel()}</label><input type="number" value="${syncedMileage}" onblur="saveJobFieldNum(${job.id},'mileage_in',this.value)" /></div>
          <div class="form-row"><label>Est. completion</label><input type="date" value="${job.est_completion||''}" onblur="saveJobField(${job.id},'est_completion',this.value)" /></div>
        </div>
        <div class="form-row"><label>Customer notes</label><textarea rows="2" onblur="saveJobField(${job.id},'customer_notes',this.value)">${escHtml(job.customer_notes||'')}</textarea></div>
        <div class="form-row"><label>Internal notes</label><textarea rows="2" onblur="saveJobField(${job.id},'internal_notes',this.value)">${escHtml(job.internal_notes||'')}</textarea></div>
      </div>

      <div class="card">
        <div class="card-title" style="margin-bottom:10px">Customer</div>
        ${client ? `<div class="flex gap-8"><div class="avatar">${initials(client.name)}</div><div><div style="font-weight:500">${escHtml(client.name)}</div><div class="text-sm text-muted">${escHtml(client.phone||'')} &middot; ${escHtml(client.email||'')}</div></div></div>` : ''}
      </div>

      <div class="card">
        <div class="vehicle-card-header">
          <div class="card-title">Vehicle</div>
          ${renderVehicleVinInline(vehicle)}
        </div>
        ${vehicle ? `
        <div class="detail-grid">
          <div class="detail-item"><div class="dl">Registration</div><div class="dv" style="font-weight:600">${escHtml(vehicle.registration)}</div></div>
          <div class="detail-item"><div class="dl">Make / Model</div><div class="dv">${escHtml(vehicle.make)} ${escHtml(vehicle.model)}</div></div>
          <div class="detail-item"><div class="dl">Year</div><div class="dv">${vehicle.year||'&mdash;'}</div></div>
          <div class="detail-item"><div class="dl">Engine</div><div class="dv">${vehicle.engine ? escHtml(vehicle.engine) : '&mdash;'}</div></div>
          <div class="detail-item"><div class="dl">Fuel</div><div class="dv">${vehicle.fuel_type ? escHtml(vehicle.fuel_type) : '&mdash;'}</div></div>
          <div class="detail-item"><div class="dl">Colour</div><div class="dv">${vehicle.colour ? escHtml(vehicle.colour) : '&mdash;'}</div></div>
          <div class="detail-item"><div class="dl">${getDistanceInLabel()}</div><div class="dv">${fmtDistanceValue(syncedMileage)}</div></div>
          <div class="detail-item"><div class="dl">MOT due</div><div class="dv">${fmtDate(vehicle.mot_due)}</div></div>
        </div>` : ''}
      </div>

      ${inv ? `
      <div class="card">
        <div class="card-header"><span class="card-title">Invoice</span>${statusBadge(invoiceDisplayStatus)}</div>
        <div class="detail-grid">
          <div class="detail-item"><div class="dl">Number</div><div class="dv">${escHtml(inv.invoice_number)}</div></div>
          <div class="detail-item"><div class="dl">Issued</div><div class="dv">${fmtDate(inv.date_issued)}</div></div>
          <div class="detail-item"><div class="dl">Due</div><div class="dv">${fmtDate(inv.due_date)}</div></div>
          <div class="detail-item"><div class="dl">Total</div><div class="dv" style="font-weight:500">${fmt(invoiceTotal)}</div></div>
          ${shouldShowInvoicePaymentRows(inv, invoicePaidAmount) ? `<div class="detail-item"><div class="dl">Paid</div><div class="dv text-green" style="font-weight:500">${fmt(invoicePaidAmount)}</div></div>` : ''}
          ${invoiceBalanceDue > 0 ? `<div class="detail-item"><div class="dl">Balance due</div><div class="dv text-red" style="font-weight:500">${fmt(invoiceBalanceDue)}</div></div>` : ''}
        </div>
        ${invoiceBalanceDue > 0 ? `<button class="btn btn-primary btn-sm" style="margin-top:10px" onclick="markPaid(${inv.id})">Mark as paid</button>` : ''}
      </div>` : ''}
    </div>
  </div>`;
}

function renderLineStatusToggle(line) {
  if (!line?.id) return '';
  const status = normalizeLineStatus(line.line_status);
  const label = status === 'pending' ? 'Pending' : 'Confirmed';
  return `
    <button
      type="button"
      class="line-status-toggle ${status === 'pending' ? 'is-pending' : 'is-confirmed'}"
      onclick="toggleLineStatus(${line.id})"
      title="${label}"
      aria-label="${label}"
    >
      ${renderLineStatusIcon(status)}
    </button>
  `;
}

function syncLineStatusUi(lineId) {
  const line = state.invoiceLines.find(item => item.id === lineId) || state.jobLines.find(item => item.id === lineId);
  if (!line) return;
  const row = document.querySelector(`[data-line-id="${lineId}"]`);
  if (row) {
    row.classList.toggle('line-row-pending', isLinePending(line));
  }
  const statusCell = document.getElementById(`job-line-${lineId}-status-cell`);
  if (statusCell) {
    statusCell.innerHTML = renderLineStatusToggle(line);
  }
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function getInvoiceTotalAmount(invoice) {
  return roundMoney(Math.max(0, Number(invoice?.total ?? invoice?.amount ?? invoice?.subtotal ?? 0) || 0));
}

function normalizeInvoiceStatusValue(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'paid') return 'Paid';
  if (normalized === 'partial' || normalized === 'part paid') return 'Partial';
  return 'Unpaid';
}

function normalizeInvoicePaidAmount(value, max = Number.POSITIVE_INFINITY) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const ceiling = Number.isFinite(Number(max)) ? Math.max(0, Number(max)) : Number.POSITIVE_INFINITY;
  return Math.min(roundMoney(Math.max(0, parsed)), roundMoney(ceiling));
}

function getInvoicePaidAmount(invoice, total = getInvoiceTotalAmount(invoice)) {
  const safeTotal = getInvoiceTotalAmount({ total });
  const status = normalizeInvoiceStatusValue(invoice?.status);
  const storedPaid = invoice?.paid_amount ?? invoice?.amount_paid ?? invoice?.paid_total ?? invoice?.total_paid ?? invoice?.payment_amount ?? 0;
  if (status === 'Paid') return safeTotal;
  if (status === 'Partial') return normalizeInvoicePaidAmount(storedPaid, safeTotal);
  const parsed = Number(storedPaid);
  return Number.isFinite(parsed) && parsed > 0 ? normalizeInvoicePaidAmount(parsed, safeTotal) : 0;
}

function getInvoiceBalanceDue(invoice, total = getInvoiceTotalAmount(invoice)) {
  const safeTotal = getInvoiceTotalAmount({ total });
  return roundMoney(Math.max(0, safeTotal - getInvoicePaidAmount(invoice, safeTotal)));
}

function shouldShowInvoicePaymentRows(invoice, paidAmount = getInvoicePaidAmount(invoice)) {
  const status = normalizeInvoiceStatusValue(invoice?.status);
  return status === 'Partial' || status === 'Paid' || paidAmount > 0;
}

function getLineBreakdownKey(lineType) {
  const normalizedType = String(lineType || DEFAULT_LINE_TYPE).trim().toLowerCase();
  if (normalizedType === 'labour') return 'labour';
  if (normalizedType === 'part') return 'parts';
  return 'other';
}

function calculateLineTypeBreakdown(lines = []) {
  const totals = { labour: 0, parts: 0, other: 0 };
  (lines || []).forEach(line => {
    const key = getLineBreakdownKey(line?.line_type);
    totals[key] += (Number(line?.qty) || 0) * (Number(line?.unit_price) || 0);
  });
  return {
    labour: roundMoney(totals.labour),
    parts: roundMoney(totals.parts),
    other: roundMoney(totals.other),
  };
}

function getInvoiceEditorSyncMeta() {
  if (state.invoiceEditorCloudSaving) {
    return {
      buttonLabel: 'Saving...',
      note: 'Saving invoice changes to your account...',
      disabled: true,
      primary: false,
    };
  }
  if (state.invoiceEditorDirty) {
    return {
      buttonLabel: 'Save',
      note: 'Changes are saved on this device. Press Save when ready to back them up.',
      disabled: !isCloudSignedIn(),
      primary: true,
    };
  }
  return {
    buttonLabel: 'Saved',
    note: 'Invoice changes are backed up.',
    disabled: true,
    primary: false,
  };
}

function updateInvoiceEditorSaveUi() {
  const meta = getInvoiceEditorSyncMeta();
  const button = document.getElementById('invoice-editor-save-cloud-btn');
  const note = document.getElementById('invoice-editor-save-note');
  if (button) {
    button.textContent = meta.buttonLabel;
    button.disabled = meta.disabled;
    button.classList.toggle('btn-primary', meta.primary);
  }
  if (note) {
    note.textContent = meta.note;
  }
}

function setInvoiceEditorDirty(dirty = true) {
  state.invoiceEditorDirty = Boolean(dirty);
  updateInvoiceEditorSaveUi();
}

function calculateInvoiceDraftTotals(inv, lines = state.invoiceLines) {
  const vatRate = getAppliedVatRate();
  const subtotal = roundMoney((lines || []).reduce((sum, line) => {
    return sum + ((Number(line?.qty) || 0) * (Number(line?.unit_price) || 0));
  }, 0));
  const vat = roundMoney(getVatAmount(subtotal, vatRate));
  const total = roundMoney(subtotal + vat);
  const paidAmount = getInvoicePaidAmount(inv, total);
  const balanceDue = getInvoiceBalanceDue(inv, total);
  const lineBreakdown = calculateLineTypeBreakdown(lines);
  return { subtotal, vatRate, vat, total, paidAmount, balanceDue, lineBreakdown };
}

function applyInvoiceDraftTotals(invoiceId = state.invoiceEditorId) {
  const inv = getInvoiceById(invoiceId);
  if (!inv) return null;
  const totals = calculateInvoiceDraftTotals(inv, state.invoiceLines);
  Object.assign(inv, totals, { vat_rate: totals.vatRate, paid_amount: totals.paidAmount });
  return inv;
}

function syncInvoiceEditorTotalsUi(invoiceId = state.invoiceEditorId) {
  const inv = applyInvoiceDraftTotals(invoiceId);
  if (!inv) return null;
  const subtotal = document.getElementById('invoice-editor-subtotal');
  const vatLabel = document.getElementById('invoice-editor-vat-label');
  const vat = document.getElementById('invoice-editor-vat');
  const total = document.getElementById('invoice-editor-total');
  const paidAmount = document.getElementById('invoice-editor-paid-amount');
  const balanceDue = document.getElementById('invoice-editor-balance-due');
  const paidInput = document.getElementById(`invoice-${invoiceId}-paid-amount`);
  const breakdown = inv.lineBreakdown || calculateLineTypeBreakdown(state.invoiceLines);
  if (subtotal) subtotal.textContent = fmt(inv.subtotal || 0);
  if (vatLabel) vatLabel.textContent = getVatLabel(inv.vat_rate);
  if (vat) vat.textContent = fmt(inv.vat || 0);
  if (total) total.textContent = fmt(inv.total || 0);
  if (paidAmount) paidAmount.textContent = fmt(inv.paidAmount || 0);
  if (balanceDue) balanceDue.textContent = fmt(inv.balanceDue || 0);
  if (paidInput && document.activeElement !== paidInput) {
    paidInput.value = inv.paidAmount ? Number(inv.paidAmount).toFixed(2) : '';
  }
  [
    ['invoice-editor-labour-total', breakdown.labour],
    ['invoice-editor-parts-total', breakdown.parts],
    ['invoice-editor-other-total', breakdown.other],
  ].forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = fmt(value || 0);
  });
  return inv;
}

function syncLineState(lineId, overrides = {}) {
  let updatedLine = null;
  [state.jobLines, state.invoiceLines, state.allJobLines].forEach(lines => {
    const line = lines.find(item => item.id === lineId);
    if (!line) return;
    Object.assign(line, overrides);
    updatedLine = line;
  });
  return updatedLine;
}

function removeLineFromState(lineId) {
  state.jobLines = state.jobLines.filter(line => line.id !== lineId);
  state.invoiceLines = state.invoiceLines.filter(line => line.id !== lineId);
  state.allJobLines = state.allJobLines.filter(line => line.id !== lineId);
}

function getBookingById(bookingId) {
  return state.bookings.find(b => b.id === bookingId) || null;
}

function getJobByBookingId(bookingId) {
  const numericBookingId = parseInt(bookingId, 10);
  if (!numericBookingId) return null;
  return state.jobs.find(job => Number(job.booking_id || 0) === numericBookingId) || null;
}

function getJobSourceBookings() {
  return state.bookings
    .filter(booking => booking.status !== 'Cancelled')
    .slice()
    .sort((a, b) => `${a.date || ''} ${a.time || ''}`.localeCompare(`${b.date || ''} ${b.time || ''}`));
}

function renderBookingJobAction(booking) {
  const job = getJobByBookingId(booking.id);
  if (job) {
    return `<button class="btn btn-sm" onclick="event.stopPropagation();openJob(${job.id})">Open job #${job.id}</button>`;
  }
  if (booking.status === 'Cancelled') return '';
  return `<button class="btn btn-sm btn-primary" onclick="event.stopPropagation();showJobModal(null,{bookingId:${booking.id}})">Create job</button>`;
}

function getInvoiceByJobId(jobId) {
  return state.invoices.find(i => i.job_id === jobId) || null;
}

function getInvoiceCreateVehicles(clientId = '') {
  const cid = parseInt(clientId, 10);
  if (Number.isNaN(cid)) return [];
  return state.vehicles.filter(vehicle => vehicle.client_id === cid);
}

function getInvoiceCreateJobs(clientId = '', vehicleId = '') {
  const cid = parseInt(clientId, 10);
  const vid = parseInt(vehicleId, 10);
  return [...state.jobs]
    .filter(job => (Number.isNaN(cid) || job.client_id === cid) && (Number.isNaN(vid) || job.vehicle_id === vid))
    .sort((a, b) => {
      const aHasInvoice = Boolean(getInvoiceByJobId(a.id));
      const bHasInvoice = Boolean(getInvoiceByJobId(b.id));
      if (aHasInvoice !== bHasInvoice) return Number(aHasInvoice) - Number(bHasInvoice);
      return `${b.date_opened || ''}`.localeCompare(`${a.date_opened || ''}`) || (b.id - a.id);
    });
}

function getPreferredInvoiceCreateJob(jobs) {
  return jobs.find(job => !getInvoiceByJobId(job.id)) || jobs[0] || null;
}

function buildInvoiceCreateDraft(presetJobId = null) {
  const presetJob = presetJobId ? state.jobs.find(job => job.id === presetJobId) : null;
  const fallbackJob = presetJob || getPreferredInvoiceCreateJob(getInvoiceCreateJobs());
  return {
    clientId: fallbackJob ? String(fallbackJob.client_id) : '',
    vehicleId: fallbackJob ? String(fallbackJob.vehicle_id) : '',
    jobId: fallbackJob ? String(fallbackJob.id) : '',
  };
}

function getInvoiceCreateDraft() {
  if (!state.invoiceCreateDraft) {
    state.invoiceCreateDraft = buildInvoiceCreateDraft();
  }
  return state.invoiceCreateDraft;
}

function renderInvoiceCreateModal() {
  const draft = getInvoiceCreateDraft();
  const vehicles = getInvoiceCreateVehicles(draft.clientId);
  const jobs = getInvoiceCreateJobs(draft.clientId, draft.vehicleId);
  const selectedJob = jobs.find(job => String(job.id) === String(draft.jobId)) || null;
  const selectedClient = state.clients.find(client => String(client.id) === String(draft.clientId)) || null;
  const selectedVehicle = state.vehicles.find(vehicle => String(vehicle.id) === String(draft.vehicleId)) || null;
  const existingInvoice = selectedJob ? getInvoiceByJobId(selectedJob.id) : null;
  const actionLabel = existingInvoice ? `Open ${existingInvoice.invoice_number}` : 'Create invoice';
  return `<div class="modal modal-wide">
    <h2>New Invoice</h2>
    <div class="form-grid" style="margin-bottom:12px">
      <div class="form-row"><label>Customer *</label>
        <select id="invoice-create-client" onchange="setInvoiceCreateClient(this.value)">
          <option value="">Select customer...</option>
          ${state.clients.map(client => `<option value="${client.id}" ${String(client.id) === String(draft.clientId) ? 'selected' : ''}>${escHtml(client.name)}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>Vehicle *</label>
        <select id="invoice-create-vehicle" onchange="setInvoiceCreateVehicle(this.value)">
          <option value="">Select vehicle…</option>
          ${vehicles.map(vehicle => `<option value="${vehicle.id}" ${String(vehicle.id) === String(draft.vehicleId) ? 'selected' : ''}>${escHtml(vehicle.registration)} — ${escHtml(vehicle.make)} ${escHtml(vehicle.model)}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>Job card *</label>
        <select id="invoice-create-job" onchange="setInvoiceCreateJob(this.value)">
          <option value="">Select job card…</option>
          ${jobs.map(job => {
            const invoice = getInvoiceByJobId(job.id);
            const suffix = invoice ? ` · ${invoice.invoice_number} exists` : '';
            return `<option value="${job.id}" ${String(job.id) === String(draft.jobId) ? 'selected' : ''}>#${job.id} · ${escHtml(job.registration || 'No vehicle')} · ${escHtml(job.status || 'New')}${escHtml(suffix)}</option>`;
          }).join('')}
        </select>
      </div>
    </div>
    <div style="background:var(--surface2);border-radius:var(--radius);padding:12px 14px;margin-bottom:12px">
      <div style="font-weight:500">${escHtml(selectedClient?.name || 'No customer selected')}</div>
      <div class="text-sm text-muted" style="margin-top:4px">${escHtml(selectedVehicle ? `${selectedVehicle.registration} · ${selectedVehicle.make} ${selectedVehicle.model}` : 'Choose a vehicle')}</div>
      <div class="text-sm text-muted" style="margin-top:4px">${escHtml(selectedJob ? `Job #${selectedJob.id} · ${selectedJob.status || 'New'} · Opened ${fmtDate(selectedJob.date_opened)}` : 'Choose a job card to continue')}</div>
      ${existingInvoice ? `<div class="text-sm" style="margin-top:8px;color:var(--amber-text)">This job already has ${escHtml(existingInvoice.invoice_number)}. The button below will open it.</div>` : ''}
      ${!jobs.length ? `<div class="text-sm" style="margin-top:8px;color:var(--red-text)">No job cards match this customer and vehicle yet.</div>` : ''}
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="createInvoiceFromDraft()" ${selectedJob ? '' : 'disabled'}>${actionLabel}</button>
    </div>
  </div>`;
}

function refreshInvoiceCreateModal() {
  if (!document.getElementById('modal-overlay')) return;
  const overlay = document.getElementById('modal-overlay');
  const activeSnapshot = snapshotActiveField(overlay);
  showModal(renderInvoiceCreateModal());
  restoreActiveField(activeSnapshot);
}

function showInvoiceCreateModal(presetJobId = null) {
  state.invoiceCreateDraft = buildInvoiceCreateDraft(presetJobId);
  showModal(renderInvoiceCreateModal());
}

function setInvoiceCreateClient(clientId) {
  const draft = getInvoiceCreateDraft();
  draft.clientId = String(clientId || '');
  const matchingJobs = getInvoiceCreateJobs(draft.clientId);
  const currentJob = matchingJobs.find(job => String(job.id) === String(draft.jobId)) || null;
  const nextJob = currentJob || getPreferredInvoiceCreateJob(matchingJobs);
  if (nextJob) {
    draft.jobId = String(nextJob.id);
    draft.vehicleId = String(nextJob.vehicle_id);
  } else {
    const vehicles = getInvoiceCreateVehicles(draft.clientId);
    draft.vehicleId = String(vehicles[0]?.id || '');
    draft.jobId = '';
  }
  refreshInvoiceCreateModal();
}

function setInvoiceCreateVehicle(vehicleId) {
  const draft = getInvoiceCreateDraft();
  draft.vehicleId = String(vehicleId || '');
  const matchingJobs = getInvoiceCreateJobs(draft.clientId, draft.vehicleId);
  const currentJob = matchingJobs.find(job => String(job.id) === String(draft.jobId)) || null;
  draft.jobId = String((currentJob || getPreferredInvoiceCreateJob(matchingJobs))?.id || '');
  refreshInvoiceCreateModal();
}

function setInvoiceCreateJob(jobId) {
  const draft = getInvoiceCreateDraft();
  draft.jobId = String(jobId || '');
  const job = state.jobs.find(item => String(item.id) === String(draft.jobId));
  if (job) {
    draft.clientId = String(job.client_id);
    draft.vehicleId = String(job.vehicle_id);
  }
  refreshInvoiceCreateModal();
}

function getClientBookings(clientId) {
  return state.bookings
    .filter(b => b.client_id === clientId)
    .slice()
    .sort((a, b) => `${b.date || ''} ${b.time || ''}`.localeCompare(`${a.date || ''} ${a.time || ''}`));
}

function getVehicleBookings(vehicleId) {
  return state.bookings.filter(booking => Number(booking.vehicle_id) === Number(vehicleId));
}

function getVehicleJobs(vehicleId) {
  return state.jobs.filter(job => Number(job.vehicle_id) === Number(vehicleId));
}

function getClientById(clientId) {
  return state.clients.find(c => c.id === clientId) || null;
}

function isUnknownCustomerPlaceholder(client) {
  if (!client) return false;
  const name = String(client.name || '').trim().toLowerCase();
  if (!UNKNOWN_CUSTOMER_NAME_PATTERN.test(name)) return false;
  const notes = String(client.notes || '').toLowerCase();
  const hasNoContact = !String(client.phone || '').trim() && !String(client.email || '').trim() && !String(client.company || '').trim();
  return hasNoContact || notes.includes('system placeholder');
}

function getBillableCustomerCount() {
  return (state.clients || []).filter(client => !isUnknownCustomerPlaceholder(client)).length;
}

function getNextUnknownCustomerName() {
  const unknownNumbers = (state.clients || [])
    .filter(client => UNKNOWN_CUSTOMER_NAME_PATTERN.test(String(client.name || '').trim()))
    .map(client => {
      const match = String(client.name || '').trim().match(/#(\d+)$/);
      return match ? parseInt(match[1], 10) : 1;
    })
    .filter(Number.isFinite);
  const nextUnknownNumber = unknownNumbers.length ? Math.max(...unknownNumbers) + 1 : 1;
  return `${UNKNOWN_CUSTOMER_NAME} #${nextUnknownNumber}`;
}

async function getOrCreateUnknownCustomer() {
  const unknownName = getNextUnknownCustomerName();
  const clientId = await invoke('save_client', {
    client: {
      id: null,
      name: unknownName,
      phone: '',
      email: '',
      address: '',
      company: '',
      notes: UNKNOWN_CUSTOMER_NOTES,
    }
  });
  state.clients = [
    ...(state.clients || []),
    {
      id: clientId,
      name: unknownName,
      phone: '',
      email: '',
      address: '',
      company: '',
      notes: UNKNOWN_CUSTOMER_NOTES,
    },
  ];
  await syncAfterCloudMutation();
  return clientId;
}

function getUnknownCustomerFallback(clientId) {
  return {
    id: clientId,
    name: getClientById(clientId)?.name || UNKNOWN_CUSTOMER_NAME,
    phone: '',
    email: '',
  };
}

function getCloudSession() {
  const cloud = {
    configured: false,
    account_email: '',
    user_id: '',
    access_token: '',
    refresh_token: '',
    last_synced_at: '',
    ...(state.cloud || {}),
  };
  return {
    ...cloud,
    configured: isAuthConfigured(),
  };
}

function getAppUpdateState() {
  if (!state.appUpdate) {
    state.appUpdate = {
      currentVersion: '',
      configured: false,
      checking: false,
      installing: false,
      availableVersion: '',
      availableNotes: '',
      availableDate: '',
      checkedAt: '',
      notice: '',
      noticeTone: 'blue',
    };
  }
  return state.appUpdate;
}

function isCloudSignedIn() {
  return Boolean(getCloudSession().user_id);
}

function getCloudStatusMeta(session = getCloudSession()) {
  if (!session.configured) return { label: 'Setup needed', tone: 'amber' };
  if (session.user_id && session.last_synced_at) return { label: 'Backed up', tone: 'green' };
  if (session.user_id) return { label: 'Signed in', tone: 'blue' };
  return { label: 'Signed out', tone: 'gray' };
}

function renderCloudStatusBadge(session = getCloudSession()) {
  const meta = getCloudStatusMeta(session);
  return `<span class="badge badge-${meta.tone}">${escHtml(meta.label)}</span>`;
}

function getCloudFormState() {
  if (!state.cloudForm) {
    state.cloudForm = {
      mode: 'login',
      garageName: '',
      email: '',
      password: '',
      confirmPassword: '',
      verificationCode: '',
      loading: false,
      error: '',
      success: '',
      notice: '',
      noticeTone: 'blue',
    };
  }
  state.cloudForm.garageName = state.cloudForm.garageName || '';
  state.cloudForm.password = state.cloudForm.password || '';
  state.cloudForm.confirmPassword = state.cloudForm.confirmPassword || '';
  state.cloudForm.loading = Boolean(state.cloudForm.loading);
  state.cloudForm.verificationCode = state.cloudForm.verificationCode || '';
  state.cloudForm.error = state.cloudForm.error || '';
  state.cloudForm.success = state.cloudForm.success || '';
  state.cloudForm.notice = state.cloudForm.notice || '';
  state.cloudForm.noticeTone = state.cloudForm.noticeTone || 'blue';
  return state.cloudForm;
}

function syncCloudField(field, value) {
  const form = getCloudFormState();
  form[field] = value;
  form.error = '';
  form.success = '';
  form.notice = '';
}

function setCloudAuthNotice(message = '', tone = 'blue') {
  const form = getCloudFormState();
  form.notice = message;
  form.noticeTone = tone;
  form.error = tone === 'red' ? message : '';
  form.success = tone === 'red' ? '' : message;
}

function setCloudAuthLoading(loading) {
  const form = getCloudFormState();
  form.loading = Boolean(loading);
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Something went wrong.');
}

function parseCloudTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRemoteSnapshotNewer(remoteSyncedAt, localSyncedAt) {
  const remoteTime = parseCloudTimestamp(remoteSyncedAt);
  const localTime = parseCloudTimestamp(localSyncedAt);
  if (!remoteTime) return false;
  if (!localTime) return true;
  return remoteTime > localTime;
}

function shouldDeferCloudAutoRefresh() {
  return Boolean(
    cloudHasUnsyncedLocalChanges ||
    state.invoiceEditorDirty ||
    state.invoiceEditorCloudSaving ||
    document.getElementById('modal-overlay')
  );
}

const VEHICLE_LIMIT_MESSAGE = 'You have reached your monthly vehicle limit. Upgrade your plan to add more vehicles.';
const CUSTOMER_LIMIT_MESSAGE = 'You have reached your customer record limit. Upgrade your plan to add more customers.';
const BOOKING_LIMIT_MESSAGE = 'You have reached your monthly booking limit. Upgrade your plan to add more bookings.';
const JOB_CARD_LIMIT_MESSAGE = 'You have reached your monthly job card limit. Upgrade your plan to add more job cards.';
const BILLING_UNLIMITED_LIMIT = 1_000_000;
const BILLING_PLAN_ORDER = ['pit_stop', 'service_bay', 'full_workshop', 'garage_empire'];
const BILLING_PLAN_META = {
  pit_stop: {
    kicker: 'Starter bay',
    title: 'Pit Stop',
    price: '£0',
    badge: '',
    features: [
      '30 bookings',
      '30 customer records',
      '30 job cards',
      'Basic invoices',
      'No vehicle checks',
      'No SMS included',
    ],
  },
  service_bay: {
    kicker: 'Daily garage',
    title: 'Service Bay',
    price: '£39',
    badge: 'Beginner',
    features: [
      '100 bookings',
      '100 customer records',
      '100 job cards',
      '100 vehicle checks',
      '100 SMS per month',
      'Automated MOT reminders',
      'Car-ready SMS notifications',
    ],
  },
  full_workshop: {
    kicker: 'Busy workshop',
    title: 'Full Workshop',
    price: '£69',
    badge: 'Most popular',
    features: [
      '200 bookings',
      '200 customer records',
      '200 job cards',
      '200 vehicle checks',
      '250 SMS per month',
      'Priority support',
    ],
  },
  garage_empire: {
    kicker: 'Full power',
    title: 'Garage Empire',
    price: '£99',
    badge: '',
    features: [
      'Unlimited bookings',
      'Unlimited customer records',
      'Unlimited job cards',
      '500 vehicle checks',
      '500 SMS per month',
      'Priority support',
    ],
  },
};

function normalizeBillingPlanKey(plan = 'pit_stop') {
  const normalized = String(plan || 'pit_stop').toLowerCase();
  if (normalized === 'free') return 'pit_stop';
  if (normalized === 'basic') return 'service_bay';
  if (normalized === 'ultimate') return 'garage_empire';
  return BILLING_PLAN_META[normalized] ? normalized : 'pit_stop';
}

function getBillingPlanMeta(plan = 'pit_stop') {
  return BILLING_PLAN_META[normalizeBillingPlanKey(plan)] || BILLING_PLAN_META.pit_stop;
}

function formatBillingPlanName(plan = 'pit_stop') {
  return getBillingPlanMeta(plan).title;
}

function isBillingAdminAccount(snapshot) {
  return Boolean(snapshot?.isAdminAccount);
}

function isBillingUnlimited(limit) {
  return Number(limit || 0) >= BILLING_UNLIMITED_LIMIT;
}

function formatBillingLimit(limit) {
  return isBillingUnlimited(limit) ? 'Unlimited' : String(Number(limit || 0));
}

function formatBillingDate(value) {
  if (!value) return 'Not set';
  return fmtDate(String(value).slice(0, 10));
}

function setBillingNotice(message = '', tone = 'blue', checkoutUrl = '') {
  state.billingNotice = message ? { message, tone, checkoutUrl } : null;
}

function getPendingBillingCheckout() {
  if (state.billingPendingCheckout?.sessionId && state.billingPendingCheckout?.garageId) {
    return state.billingPendingCheckout;
  }
  try {
    const raw = window.localStorage.getItem(BILLING_PENDING_CHECKOUT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed?.sessionId && parsed?.garageId) {
      state.billingPendingCheckout = parsed;
      return parsed;
    }
  } catch {
    window.localStorage.removeItem(BILLING_PENDING_CHECKOUT_STORAGE_KEY);
  }
  return null;
}

function setPendingBillingCheckout(value = null) {
  state.billingPendingCheckout = value;
  try {
    if (value?.sessionId && value?.garageId) {
      window.localStorage.setItem(BILLING_PENDING_CHECKOUT_STORAGE_KEY, JSON.stringify(value));
    } else {
      window.localStorage.removeItem(BILLING_PENDING_CHECKOUT_STORAGE_KEY);
    }
  } catch {
    state.billingPendingCheckout = value;
  }
}

function normalizeBillingReferralCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 32);
}

function loadStoredBillingReferralCode() {
  try {
    return normalizeBillingReferralCode(window.localStorage.getItem(BILLING_REFERRAL_CODE_STORAGE_KEY) || '');
  } catch {
    return '';
  }
}

function persistBillingReferralCode(code) {
  try {
    if (code) {
      window.localStorage.setItem(BILLING_REFERRAL_CODE_STORAGE_KEY, code);
    } else {
      window.localStorage.removeItem(BILLING_REFERRAL_CODE_STORAGE_KEY);
    }
  } catch {}
}

function setBillingReferralCode(value) {
  const code = normalizeBillingReferralCode(value);
  state.billingReferralCode = code;
  persistBillingReferralCode(code);
  const input = document.getElementById('billing-referral-code');
  if (input && input.value !== code) input.value = code;
}

function captureBillingReferralCodeFromUrl() {
  if (typeof window === 'undefined') return;
  try {
    const params = new URLSearchParams(window.location.search || '');
    const fromUrl = normalizeBillingReferralCode(params.get('ref') || params.get('referral') || params.get('referral_code') || '');
    if (fromUrl) {
      setBillingReferralCode(fromUrl);
      return;
    }
    if (!state.billingReferralCode) {
      state.billingReferralCode = loadStoredBillingReferralCode();
    }
  } catch {
    if (!state.billingReferralCode) state.billingReferralCode = loadStoredBillingReferralCode();
  }
}

async function syncPendingBillingCheckout({ showNotice = false } = {}) {
  const pending = getPendingBillingCheckout();
  if (!pending?.sessionId || !pending?.garageId) return null;
  try {
    const result = await syncCheckoutSession(pending.garageId, pending.sessionId);
    if (result?.synced) {
      setPendingBillingCheckout(null);
      setBillingNotice('Payment confirmed. Your plan has been refreshed.', 'green');
      return result;
    }
    if (showNotice) {
      setBillingNotice('Payment confirmation is still processing. Try refresh again in a moment.', 'amber');
    }
    return result;
  } catch (error) {
    if (showNotice) {
      setBillingNotice(getErrorMessage(error), 'red');
    }
    console.warn('Unable to sync pending checkout', error);
    return null;
  }
}

function renderBillingNotice() {
  const notice = state.billingNotice;
  if (!notice?.message) return '';
  const tone = ['blue', 'green', 'amber', 'red'].includes(notice.tone) ? notice.tone : 'blue';
  const checkoutUrl = String(notice.checkoutUrl || '');
  return `
    <div class="auth-note auth-note-${tone} billing-notice">
      <div>${escHtml(notice.message)}</div>
      ${checkoutUrl ? `
        <div class="billing-link-fallback">
          <input id="billing-checkout-link" type="text" readonly value="${escHtml(checkoutUrl)}" />
          <button class="btn btn-sm" onclick="copyCheckoutLink()">Copy checkout link</button>
        </div>
      ` : ''}
    </div>
  `;
}

async function openExternalBillingUrl(url) {
  if (!/^https:\/\/.+/i.test(String(url || ''))) {
    throw new Error('The payment page is not ready yet.');
  }
  await openUrl(url);
}

function renderBillingUsageRow({ label, used, limit, extra = 0, disabled = false }) {
  const unlimited = isBillingUnlimited(limit);
  const allowance = unlimited ? Number.POSITIVE_INFINITY : Number(limit || 0) + Number(extra || 0);
  const value = Number(used || 0);
  const percent = unlimited ? 0 : (allowance > 0 ? Math.min(100, Math.round((value / allowance) * 100)) : 0);
  const meterTone = percent >= 100 ? 'danger' : (percent >= 80 ? 'warn' : 'ok');
  const allowanceLabel = disabled || allowance === 0 ? 'Disabled' : `${value} / ${unlimited ? 'Unlimited' : allowance}`;
  const extraLabel = extra > 0 ? ` + ${extra} extra` : '';
  return `
    <div class="billing-usage-row">
      <div class="billing-usage-copy">
        <span>${escHtml(label)}</span>
        <strong>${escHtml(allowanceLabel)}${escHtml(extraLabel)}</strong>
      </div>
      <div class="billing-usage-track" aria-hidden="true">
        <span class="billing-usage-fill billing-usage-${meterTone}" style="width:${percent}%"></span>
      </div>
    </div>
  `;
}

function countSuccessfulSmsForBillingMonth(month) {
  if (!month) return 0;
  return (state.messageLog || []).filter(entry => {
    if (String(entry.channel || 'sms').toLowerCase() !== 'sms') return false;
    if (!isMessageStatusSuccess(entry.status)) return false;
    const timestamp = String(entry.sent_at || entry.sentAt || entry.created_at || entry.createdAt || '');
    return timestamp.slice(0, 7) === month;
  }).length;
}

function getEffectiveBillingUsage(snapshot) {
  const usage = snapshot?.usage || {};
  const smsFromMessageLog = countSuccessfulSmsForBillingMonth(snapshot?.month || '');
  return {
    ...usage,
    sms_used: Math.max(Number(usage.sms_used || 0), smsFromMessageLog),
  };
}

function getEffectiveBillingSnapshot(snapshot) {
  if (!snapshot) return snapshot;
  return {
    ...snapshot,
    usage: getEffectiveBillingUsage(snapshot),
  };
}

function countBookingsForBillingMonth(month = getCurrentMonthKey()) {
  return (state.bookings || []).filter(booking => {
    if (String(booking.status || '').toLowerCase() === 'cancelled') return false;
    return String(booking.date || '').slice(0, 7) === month;
  }).length;
}

function countJobCardsForBillingMonth(month = getCurrentMonthKey()) {
  return (state.jobs || []).filter(job => {
    if (String(job.status || '').toLowerCase() === 'cancelled') return false;
    return String(job.date_opened || '').slice(0, 7) === month;
  }).length;
}

function getLocalBillingUsage(snapshot) {
  const month = snapshot?.month || getCurrentMonthKey();
  return {
    bookings_used: countBookingsForBillingMonth(month),
    customer_records_used: getBillableCustomerCount(),
    job_cards_used: countJobCardsForBillingMonth(month),
  };
}

function renderBillingPlanCard(plan, snapshot) {
  const isAdmin = isBillingAdminAccount(snapshot);
  const currentPlan = normalizeBillingPlanKey(snapshot.garage?.plan || 'pit_stop');
  const planKey = normalizeBillingPlanKey(plan);
  const meta = getBillingPlanMeta(planKey);
  const isCurrent = !isAdmin && currentPlan === planKey;
  const isFree = planKey === 'pit_stop';
  const isHighlighted = planKey === 'service_bay';
  const isPopular = planKey === 'full_workshop';
  return `
    <div class="billing-plan-card ${isCurrent ? 'active' : ''} ${isHighlighted ? 'featured' : ''}">
      <div class="billing-plan-head">
        <div>
          <div class="settings-kicker">${escHtml(meta.kicker)}</div>
          <div class="billing-plan-title">${escHtml(meta.title)}</div>
        </div>
        ${meta.badge ? `<span class="billing-plan-badge ${isPopular ? 'popular' : ''}">${escHtml(meta.badge)}</span>` : ''}
      </div>
      <div class="billing-price-row">
        <span>${escHtml(meta.price)}</span><small>/month</small>
      </div>
      <div class="billing-plan-features">
        ${meta.features.map(feature => `<div><span class="billing-check">✓</span>${escHtml(feature)}</div>`).join('')}
      </div>
      ${isAdmin
        ? '<button class="btn" disabled>Admin access</button>'
        : isFree
        ? `<button class="btn" ${isCurrent ? 'disabled' : 'onclick="openBillingPortal()"'}>${isCurrent ? 'Current plan' : 'Manage billing'}</button>`
        : `<button class="btn ${isHighlighted || isPopular ? 'btn-primary' : ''}" onclick="startBillingCheckout('${planKey}')" ${isCurrent ? 'disabled' : ''}>${isCurrent ? 'Current plan' : `Upgrade to ${escHtml(meta.title)}`}</button>`}
    </div>
  `;
}

function renderBillingReferralCard() {
  const code = state.billingReferralCode || loadStoredBillingReferralCode();
  state.billingReferralCode = code;
  return `
    <div class="card billing-referral-card">
      <div>
        <div class="settings-kicker">Referral</div>
        <div class="billing-referral-title">Referral code</div>
      </div>
      <input id="billing-referral-code" type="text" maxlength="32" value="${escHtml(code)}" placeholder="Optional" oninput="setBillingReferralCode(this.value)" />
    </div>
  `;
}

async function renderBilling() {
  try {
    captureBillingReferralCodeFromUrl();
    await syncPendingBillingCheckout();
    const snapshot = getEffectiveBillingSnapshot(await loadBillingSnapshot());
    state.billingSnapshot = snapshot;
    const garage = snapshot.garage;
    const isAdmin = isBillingAdminAccount(snapshot);
    const plan = normalizeBillingPlanKey(garage?.plan || 'pit_stop');
    const planMeta = getBillingPlanMeta(plan);
    const limits = snapshot.limits;
    const usage = snapshot.usage;
    const localUsage = getLocalBillingUsage(snapshot);
    const smsAllowance = limits.max_sms_per_month + usage.extra_sms_credits;
    const vrmAllowance = limits.max_vrm_checks_per_month + usage.extra_vrm_credits;
    return `
      <div class="billing-shell">
        <div class="billing-summary-band">
          <div>
            <div class="settings-kicker">Billing</div>
            <div class="billing-title">${escHtml(isAdmin ? 'Admin account' : `${planMeta.title} plan`)}</div>
            <div class="billing-subtitle">${escHtml(isAdmin ? 'Admin access' : 'Plan and usage')}</div>
          </div>
          <div class="billing-status-stack">
            ${renderPill(isAdmin ? 'admin access' : (garage?.subscription_status || 'active'), isAdmin || plan !== 'pit_stop' ? 'green' : 'gray')}
            ${isAdmin
              ? '<span>Billing override: <strong>Enabled</strong></span>'
              : `<span>Period ends: <strong>${escHtml(formatBillingDate(garage?.current_period_end))}</strong></span>`}
          </div>
        </div>

        ${renderBillingNotice()}

        ${isAdmin ? '' : renderBillingReferralCard()}

        <div class="billing-grid">
          <div class="card billing-card">
            <div class="card-header">
              <span class="card-title">This month</span>
              <span class="badge badge-blue">${escHtml(snapshot.month)}</span>
            </div>
            ${renderBillingUsageRow({ label: 'Bookings', used: localUsage.bookings_used, limit: limits.max_bookings_per_month })}
            ${renderBillingUsageRow({ label: 'Customer records', used: localUsage.customer_records_used, limit: limits.max_customer_records })}
            ${renderBillingUsageRow({ label: 'Job cards', used: localUsage.job_cards_used, limit: limits.max_job_cards_per_month })}
            ${renderBillingUsageRow({ label: 'SMS credits', used: usage.sms_used, limit: limits.max_sms_per_month, extra: usage.extra_sms_credits, disabled: !canSendSmsForBilling(snapshot) && smsAllowance === 0 })}
            ${renderBillingUsageRow({ label: 'Vehicle checks', used: usage.vrm_checks_used, limit: limits.max_vrm_checks_per_month, extra: usage.extra_vrm_credits, disabled: !canCheckVrmForBilling(snapshot) && vrmAllowance === 0 })}
          </div>

          <div class="card billing-card">
            <div class="card-header">
              <span class="card-title">Entitlements</span>
              <span class="badge ${limits.can_use_automations ? 'badge-green' : 'badge-gray'}">${limits.can_use_automations ? 'Automation ready' : 'Core CRM'}</span>
            </div>
            <div class="billing-entitlement-list">
              <div><span>Bookings</span><strong>${escHtml(formatBillingLimit(limits.max_bookings_per_month))}</strong></div>
              <div><span>Customer records</span><strong>${escHtml(formatBillingLimit(limits.max_customer_records))}</strong></div>
              <div><span>Job cards</span><strong>${escHtml(formatBillingLimit(limits.max_job_cards_per_month))}</strong></div>
              <div><span>SMS</span><strong>${limits.can_send_sms ? 'Enabled' : 'Disabled'}</strong></div>
              <div><span>Vehicle checks</span><strong>${limits.can_check_vrm ? 'Enabled' : 'Disabled'}</strong></div>
              <div><span>Automation</span><strong>${limits.can_use_automations ? 'Enabled' : 'Core only'}</strong></div>
            </div>
            <div class="settings-actions">
              <button class="btn" onclick="refreshBillingStatus()">Refresh billing</button>
              <button class="btn" onclick="openBillingPortal()" ${!isAdmin && garage?.stripe_customer_id ? '' : 'disabled'}>${isAdmin ? 'No billing needed' : 'Manage billing'}</button>
            </div>
          </div>
        </div>

        <div class="billing-plan-grid">
          ${BILLING_PLAN_ORDER.map(planKey => renderBillingPlanCard(planKey, snapshot)).join('')}
        </div>
      </div>
    `;
  } catch (error) {
    return `
      <div class="card settings-card">
        <div class="settings-card-head">
          <div>
            <div class="settings-kicker">Billing</div>
            <div class="settings-title">Setup needed</div>
          </div>
          <span class="badge badge-amber">Unavailable</span>
        </div>
        <div class="auth-note auth-note-amber">${escHtml(getErrorMessage(error))}</div>
        <div class="settings-actions">
          <button class="btn btn-primary" onclick="render()">Retry</button>
        </div>
      </div>
    `;
  }
}

async function startBillingCheckout(plan) {
  let checkoutUrl = '';
  try {
    captureBillingReferralCodeFromUrl();
    const normalizedPlan = normalizeBillingPlanKey(plan);
    if (normalizedPlan === 'pit_stop') {
      await openBillingPortal();
      return;
    }
    setBillingNotice('Opening checkout...', 'blue');
    if (isBillingViewActive()) await renderInPlace();
    const snapshot = await loadBillingSnapshot({ force: true });
    state.billingSnapshot = snapshot;
    if (!snapshot.garage?.id) throw new Error('Garage profile is not ready for billing yet.');
    if (isBillingAdminAccount(snapshot)) {
      setBillingNotice('This admin account already has full free access. No checkout is needed.', 'green');
      if (isBillingViewActive()) await renderInPlace();
      return;
    }
    if (normalizeBillingPlanKey(snapshot.garage.plan) === normalizedPlan) {
      setBillingNotice(`${formatBillingPlanName(normalizedPlan)} is already your current plan.`, 'blue');
      if (isBillingViewActive()) await renderInPlace();
      return;
    }
    const checkout = await createCheckoutSession(normalizedPlan, snapshot.garage.id, state.billingReferralCode || '');
    checkoutUrl = checkout.url;
    if (checkout.sessionId) {
      setPendingBillingCheckout({
        garageId: snapshot.garage.id,
        sessionId: checkout.sessionId,
        plan: normalizedPlan,
        createdAt: new Date().toISOString(),
      });
    }
    await openExternalBillingUrl(checkoutUrl);
    setBillingNotice('Checkout opened in your browser. Complete the payment and return to Garage CRM.', 'green');
    invalidateBillingSnapshot();
    await loadBillingSnapshot({ force: true });
    if (isBillingViewActive()) await renderInPlace();
  } catch (error) {
    const message = checkoutUrl
      ? 'Unable to open your browser automatically. Use this checkout link to continue.'
      : getErrorMessage(error);
    setBillingNotice(message, checkoutUrl ? 'amber' : 'red', checkoutUrl);
    if (isBillingViewActive()) await renderInPlace();
  }
}

async function openBillingPortal() {
  let portalUrl = '';
  try {
    const snapshot = await loadBillingSnapshot({ force: true });
    state.billingSnapshot = snapshot;
    if (!snapshot.garage?.id) throw new Error('Garage profile is not ready for billing yet.');
    portalUrl = await createBillingPortalSession(snapshot.garage.id);
    await openExternalBillingUrl(portalUrl);
    setBillingNotice('Billing portal opened in your browser. Return to Garage CRM when finished.', 'green');
    if (isBillingViewActive()) await renderInPlace();
  } catch (error) {
    const message = portalUrl
      ? 'Unable to open your browser automatically. Use this billing portal link to continue.'
      : getErrorMessage(error);
    setBillingNotice(message, portalUrl ? 'amber' : 'red', portalUrl);
    if (isBillingViewActive()) await renderInPlace();
  }
}

async function refreshBillingStatus() {
  try {
    setBillingNotice('Refreshing billing from Stripe and Supabase...', 'blue');
    if (isBillingViewActive()) await renderInPlace();
    await syncPendingBillingCheckout({ showNotice: true });
    const snapshot = await loadBillingSnapshot({ force: true });
    if (snapshot.garage?.id) {
      const result = await syncBillingStatusFromStripe(snapshot.garage.id);
      if (result?.synced) {
        setBillingNotice('Billing status refreshed from Stripe.', 'green');
      } else if (result?.message) {
        setBillingNotice(String(result.message), 'amber');
      }
    }
    invalidateBillingSnapshot();
    await loadBillingSnapshot({ force: true });
    if (isBillingViewActive()) await renderInPlace();
  } catch (error) {
    setBillingNotice(getErrorMessage(error), 'red');
    if (isBillingViewActive()) await renderInPlace();
  }
}

async function copyCheckoutLink() {
  const input = document.getElementById('billing-checkout-link');
  const link = input?.value || state.billingNotice?.checkoutUrl || '';
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
    toast('Checkout link copied');
  } catch {
    input?.select?.();
    document.execCommand('copy');
    toast('Checkout link copied');
  }
}

async function copyVehicleVin(source) {
  const vin = String(
    typeof source === 'string'
      ? source
      : (source?.dataset?.vin || source?.closest?.('[data-vin]')?.dataset?.vin || '')
  ).trim();
  if (!vin) return;

  try {
    await navigator.clipboard.writeText(vin);
    toast('VIN copied');
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = vin;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    toast('VIN copied');
  }
}

async function refreshBillingAfterExternalReturn() {
  if (!isBillingViewActive() || !isCloudSignedIn()) return;
  await syncPendingBillingCheckout();
  invalidateBillingSnapshot();
  try {
    const snapshot = await loadBillingSnapshot({ force: true });
    if (snapshot.garage?.id) {
      await syncBillingStatusFromStripe(snapshot.garage.id);
    }
    invalidateBillingSnapshot();
    await loadBillingSnapshot({ force: true });
    await renderInPlace();
  } catch (error) {
    console.warn('Unable to refresh billing after returning to the app', error);
  }
}

async function ensureVehicleCreationAllowed() {
  try {
    const snapshot = await loadBillingSnapshot({ force: true });
    state.billingSnapshot = snapshot;
    if (!snapshot.garage?.id) return true;
    if (!canCreateVehicleForBilling(snapshot)) {
      alert(VEHICLE_LIMIT_MESSAGE);
      void nav('billing');
      return false;
    }
    const allowed = await checkVehicleUsage(snapshot.garage.id);
    if (!allowed) {
      alert(VEHICLE_LIMIT_MESSAGE);
      void nav('billing');
      return false;
    }
    return true;
  } catch (error) {
    console.warn('Billing vehicle limit check skipped', error);
    return true;
  }
}

async function recordVehicleCreatedForBilling() {
  try {
    const snapshot = state.billingSnapshot || await loadBillingSnapshot();
    if (!snapshot.garage?.id) return;
    await incrementVehicleUsage(snapshot.garage.id);
    invalidateBillingSnapshot();
  } catch (error) {
    console.warn('Vehicle saved, but billing usage was not updated', error);
    toast('Vehicle saved. Usage counter could not be updated.');
  }
}

async function ensureCustomerCreationAllowed() {
  try {
    const snapshot = await loadBillingSnapshot();
    state.billingSnapshot = snapshot;
    if (!canCreateCustomerForBilling(snapshot, getBillableCustomerCount())) {
      alert(CUSTOMER_LIMIT_MESSAGE);
      void nav('billing');
      return false;
    }
    return true;
  } catch (error) {
    console.warn('Billing customer limit check skipped', error);
    return true;
  }
}

async function ensureBookingCreationAllowed(bookingDate = '') {
  try {
    const month = String(bookingDate || '').slice(0, 7) || getCurrentMonthKey();
    const snapshot = await loadBillingSnapshot();
    state.billingSnapshot = snapshot;
    if (!canCreateBookingForBilling(snapshot, countBookingsForBillingMonth(month))) {
      alert(BOOKING_LIMIT_MESSAGE);
      void nav('billing');
      return false;
    }
    return true;
  } catch (error) {
    console.warn('Billing booking limit check skipped', error);
    return true;
  }
}

async function ensureJobCardCreationAllowed() {
  try {
    const month = getCurrentMonthKey();
    const snapshot = await loadBillingSnapshot();
    state.billingSnapshot = snapshot;
    if (!canCreateJobCardForBilling(snapshot, countJobCardsForBillingMonth(month))) {
      alert(JOB_CARD_LIMIT_MESSAGE);
      void nav('billing');
      return false;
    }
    return true;
  } catch (error) {
    console.warn('Billing job card limit check skipped', error);
    return true;
  }
}

async function ensureSmsAllowedForBilling() {
  try {
    const snapshot = getEffectiveBillingSnapshot(await loadBillingSnapshot());
    state.billingSnapshot = snapshot;
    if (!canSendSmsForBilling(snapshot)) {
      throw new Error('SMS is not available on your current plan or monthly SMS credits are used up.');
    }
  } catch (error) {
    if (String(getErrorMessage(error)).includes('does not exist')) {
      console.warn('Billing SMS check skipped', error);
      return;
    }
    throw error;
  }
}

async function ensureVrmAllowedForBilling(target) {
  try {
    const snapshot = await loadBillingSnapshot();
    state.billingSnapshot = snapshot;
    if (!canCheckVrmForBilling(snapshot)) {
      const message = 'VRM checks are not available on your current plan or monthly VRM checks are used up.';
      setDvlaLookupStatus(target, message, 'amber');
      toast(message);
      return false;
    }
    return true;
  } catch (error) {
    console.warn('Billing VRM check skipped', error);
    return true;
  }
}

function clearLoadedBusinessState() {
  state.clients = [];
  state.vehicles = [];
  state.jobs = [];
  state.invoices = [];
  state.bookings = [];
  state.workers = [];
  state.allJobLines = [];
  state.inventoryItems = [];
  state.inventoryMovements = [];
  state.messageLog = [];
  state.messageSettings = null;
  state.billingSnapshot = null;
  state.billingNotice = null;
  state.selectedClient = null;
  state.selectedJob = null;
  state.selectedInvoice = null;
  state.jobLines = [];
  state.invoiceLines = [];
  state.invoiceEditorId = null;
  state.invoiceEditorScrollTop = 0;
  state.invoiceEditorDirty = false;
  state.invoiceEditorCloudSaving = false;
  state.invoiceCreateDraft = null;
  state.bookingDraft = null;
  state.inventoryFilter = 'all';
  state.jobStatusFilter = 'active';
  state.messageFilter = 'all';
  state.autoSmsReminderRunKey = '';
}

function setSignedOutWorkspaceNotice() {
  setCloudAuthNotice('', 'blue');
}

async function syncAfterCloudMutation() {
  if (!isCloudSignedIn()) return null;
  try {
    const result = await invoke('sync_account_to_cloud');
    if (result?.synced_at) {
      state.cloud = { ...state.cloud, last_synced_at: result.synced_at };
      state.cloudHydratedUserId = getCloudSession().user_id || '';
      state.invoiceEditorDirty = false;
      cloudHasUnsyncedLocalChanges = false;
      updateInvoiceEditorSaveUi();
    }
    return result;
  } catch (error) {
    cloudHasUnsyncedLocalChanges = true;
    throw error;
  }
}

function normalizeRegistrationLookup(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function getDvlaLookupConfig(target) {
  return target === 'booking'
    ? {
        statusId: 'bf-dvla-status',
        fields: {
          registration: 'bf-vehicle-reg',
          make: 'bf-vehicle-make',
          model: 'bf-vehicle-model',
          year: 'bf-vehicle-year',
        },
      }
    : {
        statusId: 'v-dvla-status',
        fields: {
          registration: 'v-reg',
          make: 'v-make',
          model: 'v-model',
          year: 'v-year',
          engine: 'v-engine',
          fuelType: 'v-fuel',
          colour: 'v-colour',
          motDue: 'v-mot',
        },
      };
}

function setDvlaLookupStatus(target, message = '', tone = 'blue') {
  const status = document.getElementById(getDvlaLookupConfig(target).statusId);
  if (!status) return;
  status.textContent = message;
  status.className = `lookup-status lookup-status-${tone}`;
}

function setFieldValue(id, value, { allowEmpty = false } = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  const nextValue = value === undefined || value === null ? '' : String(value);
  if (!allowEmpty && !nextValue) return;
  el.value = nextValue;
}

function setSelectFieldValue(id, value) {
  const el = document.getElementById(id);
  if (!el || !value) return;
  const match = Array.from(el.options).find(option => option.value.toLowerCase() === String(value).toLowerCase());
  if (match) el.value = match.value;
}

function normalizeDvlaFuelType(value) {
  const fuel = String(value || '').trim().toUpperCase();
  if (!fuel) return '';
  if (fuel.includes('HEAVY OIL') || fuel.includes('DIESEL')) return 'Diesel';
  if (fuel.includes('ELECTRIC')) return 'Electric';
  if (fuel.includes('HYBRID')) return 'Hybrid';
  if (fuel.includes('PETROL') || fuel.includes('GAS')) return 'Petrol';
  if (fuel.includes('LPG')) return 'LPG';
  return '';
}

function applyDvlaVehicleData(target, payload) {
  const config = getDvlaLookupConfig(target);
  const fields = config.fields;
  const vehicle = payload?.vehicle || payload || {};
  const registration = normalizeRegistrationLookup(vehicle.registrationNumber || vehicle.registration || document.getElementById(fields.registration)?.value);
  const make = vehicle.make || '';
  const year = vehicle.yearOfManufacture || vehicle.year || '';
  const engine = vehicle.engine || (vehicle.engineCapacity ? `${vehicle.engineCapacity} cc` : '');
  const fuelType = normalizeDvlaFuelType(vehicle.fuelType || vehicle.fuel_type);
  const colour = vehicle.colour || vehicle.color || '';
  const motDue = vehicle.motExpiryDate || vehicle.mot_due || '';

  setFieldValue(fields.registration, registration);
  setFieldValue(fields.make, make);
  setFieldValue(fields.year, year);
  setFieldValue(fields.engine, engine);
  setSelectFieldValue(fields.fuelType, fuelType);
  setFieldValue(fields.colour, colour);
  setFieldValue(fields.motDue, motDue);

  if (target === 'booking' && state.bookingDraft) {
    state.bookingDraft.vehicleRegistration = registration;
    state.bookingDraft.vehicleMake = make;
    state.bookingDraft.vehicleYear = String(year || '');
  }

  return { registration, make, year };
}

async function lookupDvlaVehicle(target = 'vehicle') {
  const config = getDvlaLookupConfig(target);
  const regInput = document.getElementById(config.fields.registration);
  const registration = normalizeRegistrationLookup(regInput?.value);
  if (!registration) {
    setDvlaLookupStatus(target, 'Enter a registration first.', 'amber');
    return;
  }
  if (!(await ensureVrmAllowedForBilling(target))) return;

  setDvlaLookupStatus(target, 'Checking DVLA...', 'blue');
  try {
    const result = await invoke('lookup_vehicle_registration', { registration });
    const applied = applyDvlaVehicleData(target, result);
    invalidateBillingSnapshot();
    state.billingSnapshot = null;
    setDvlaLookupStatus(
      target,
      `DVLA found ${[applied.make, applied.year].filter(Boolean).join(' ') || applied.registration}. Model is optional.`,
      'green'
    );
    toast('Vehicle details filled from DVLA');
  } catch (error) {
    const message = String(error || 'DVLA lookup failed');
    setDvlaLookupStatus(target, message, 'red');
    toast(message);
  }
}

async function restoreCloudWorkspace({ force = false } = {}) {
  const session = getCloudSession();
  if (!session.user_id) {
    state.cloudHydratedUserId = '';
    clearLoadedBusinessState();
    return null;
  }
  if (state.cloudBootstrapping) return null;
  if (!force && state.cloudHydratedUserId === session.user_id) return null;

  state.cloudBootstrapping = true;
  try {
    const result = await invoke('restore_account_from_cloud');
    state.cloudHydratedUserId = session.user_id;
    if (result?.synced_at) {
      state.cloud = { ...state.cloud, last_synced_at: result.synced_at };
    }
    return result;
  } finally {
    state.cloudBootstrapping = false;
  }
}

async function refreshCloudWorkspaceIfRemoteChanged({ force = false, silent = true } = {}) {
  const session = getCloudSession();
  if (!session.user_id || state.cloudBootstrapping) return null;
  if (!force && shouldDeferCloudAutoRefresh()) return null;

  const now = Date.now();
  if (!force && now - cloudLastRemoteCheckAt < CLOUD_REMOTE_REFRESH_THROTTLE_MS) {
    return null;
  }
  cloudLastRemoteCheckAt = now;

  if (cloudRemoteRefreshInFlight) return cloudRemoteRefreshInFlight;

  cloudRemoteRefreshInFlight = (async () => {
    const remote = await invoke('get_cloud_remote_snapshot_status');
    if (!remote?.exists) return null;

    const remoteSyncedAt = remote.synced_at || remote.syncedAt || '';
    if (!force && !isRemoteSnapshotNewer(remoteSyncedAt, getCloudSession().last_synced_at)) {
      return null;
    }

    const result = await restoreCloudWorkspace({ force: true });
    if (result?.restored === false) return null;
    await loadBusinessStateFromBackend();
    if (!silent) toast('Cloud data refreshed');
    return result;
  })().finally(() => {
    cloudRemoteRefreshInFlight = null;
  });

  return cloudRemoteRefreshInFlight;
}

async function refreshCloudWorkspaceAndRender({ force = false, silent = true } = {}) {
  try {
    const result = await refreshCloudWorkspaceIfRemoteChanged({ force, silent });
    if (result) await renderInPlace();
    return result;
  } catch (error) {
    console.warn('Unable to refresh cloud workspace from remote snapshot', error);
    return null;
  }
}

async function setCloudAuthMode(mode) {
  const form = getCloudFormState();
  form.mode = ['signup', 'verify', 'reset'].includes(mode) ? mode : 'login';
  if (form.mode === 'signup' && !form.garageName) {
    form.garageName = getGarageName();
  }
  form.password = '';
  form.confirmPassword = '';
  if (form.mode !== 'verify') form.verificationCode = '';
  form.notice = '';
  form.error = '';
  form.success = '';
  form.noticeTone = 'blue';
  if (state.screen === 'settings') {
    await renderInPlace();
  }
}

function renderCloudAuthNotice() {
  const form = getCloudFormState();
  const message = form.error || form.success || form.notice;
  if (!message) return '';
  const tone = form.error ? 'red' : (form.noticeTone || 'blue');
  return `<div class="auth-note auth-note-${tone}">${escHtml(message)}</div>`;
}

function renderAppUpdateNotice(updateState = getAppUpdateState()) {
  if (!updateState.notice) return '';
  return `<div class="auth-note auth-note-${updateState.noticeTone || 'blue'}" style="margin:0 0 12px">${escHtml(updateState.notice)}</div>`;
}

function getCloudAuthModeCopy(mode) {
  if (mode === 'signup') {
    return {
      title: 'Create your account',
    };
  }
  if (mode === 'verify') {
    return {
      title: 'Verify your email',
    };
  }
  if (mode === 'reset') {
    return {
      title: 'Set a new password',
    };
  }
  return {
    title: 'Login to Garage CRM',
  };
}

function renderCloudAuthFields(cloudForm, authDisabled) {
  const mode = cloudForm.mode || 'login';
  if (mode === 'verify') {
    return `
      <div class="form-row">
        <label>Email</label>
        <input id="cloud-account-email" type="email" value="${escHtml(cloudForm.email || '')}" oninput="syncCloudField('email', this.value)" placeholder="owner@garage.com" autocomplete="username" ${authDisabled ? 'disabled' : ''} />
      </div>
      <div class="form-row">
        <label>Verification code</label>
        <input id="cloud-verification-code" type="text" inputmode="numeric" maxlength="8" value="${escHtml(cloudForm.verificationCode || '')}" oninput="syncCloudField('verificationCode', this.value.replace(/\\D/g, '').slice(0, 8))" placeholder="12345678" autocomplete="one-time-code" ${authDisabled ? 'disabled' : ''} />
        <button class="cloud-inline-link" onclick="resendCloudVerificationCode()" ${authDisabled ? 'disabled' : ''}>Resend code</button>
      </div>
    `;
  }

  if (mode === 'reset') {
    return `
      <div class="form-row">
        <label>New password</label>
        <input id="cloud-account-password" type="password" value="${escHtml(cloudForm.password || '')}" oninput="syncCloudField('password', this.value)" placeholder="At least 8 characters" autocomplete="new-password" ${authDisabled ? 'disabled' : ''} />
      </div>
      <div class="form-row">
        <label>Confirm password</label>
        <input id="cloud-account-password-confirm" type="password" value="${escHtml(cloudForm.confirmPassword || '')}" oninput="syncCloudField('confirmPassword', this.value)" placeholder="Repeat password" autocomplete="new-password" ${authDisabled ? 'disabled' : ''} />
      </div>
    `;
  }

  const isCreateMode = mode === 'signup';
  return `
    ${isCreateMode ? `
      <div class="form-row">
        <label>Garage name</label>
        <input id="cloud-garage-name" type="text" value="${escHtml(cloudForm.garageName || '')}" oninput="syncCloudField('garageName', this.value)" placeholder="Garage name" autocomplete="organization" ${authDisabled ? 'disabled' : ''} />
      </div>
    ` : ''}
    <div class="form-row">
      <label>Email</label>
      <input id="cloud-account-email" type="email" value="${escHtml(cloudForm.email || '')}" oninput="syncCloudField('email', this.value)" placeholder="owner@garage.com" autocomplete="username" ${authDisabled ? 'disabled' : ''} />
    </div>
    <div class="form-row">
      <label>Password</label>
      <input id="cloud-account-password" type="password" value="${escHtml(cloudForm.password || '')}" oninput="syncCloudField('password', this.value)" placeholder="${isCreateMode ? 'At least 8 characters' : 'Password'}" autocomplete="${isCreateMode ? 'new-password' : 'current-password'}" ${authDisabled ? 'disabled' : ''} />
      ${!isCreateMode ? `<button class="cloud-inline-link auth-inline-link" onclick="sendCloudPasswordReset()" ${authDisabled ? 'disabled' : ''}>Forgot password?</button>` : ''}
    </div>
    ${isCreateMode ? `
      <div class="form-row">
        <label>Confirm password</label>
        <input id="cloud-account-password-confirm" type="password" value="${escHtml(cloudForm.confirmPassword || '')}" oninput="syncCloudField('confirmPassword', this.value)" placeholder="Repeat password" autocomplete="new-password" ${authDisabled ? 'disabled' : ''} />
      </div>
    ` : ''}
  `;
}

function renderCloudAuthActions(cloudForm, authDisabled, isLoading) {
  const mode = cloudForm.mode || 'login';
  if (mode === 'signup') {
    return `
      <button class="btn btn-primary" onclick="signUpCloudAccount()" ${authDisabled ? 'disabled' : ''}>${isLoading ? 'Creating...' : 'Create account'}</button>
      <button class="btn" onclick="setCloudAuthMode('login')" ${authDisabled ? 'disabled' : ''}>Back to login</button>
    `;
  }
  if (mode === 'verify') {
    return `
      <button class="btn btn-primary" onclick="verifyCloudEmailCode()" ${authDisabled ? 'disabled' : ''}>${isLoading ? 'Verifying...' : 'Verify email'}</button>
      <button class="btn" onclick="setCloudAuthMode('login')" ${authDisabled ? 'disabled' : ''}>Back to login</button>
    `;
  }
  if (mode === 'reset') {
    return `
      <button class="btn btn-primary" onclick="completeCloudPasswordReset()" ${authDisabled ? 'disabled' : ''}>${isLoading ? 'Saving...' : 'Save new password'}</button>
      <button class="btn" onclick="setCloudAuthMode('login')" ${authDisabled ? 'disabled' : ''}>Back to login</button>
    `;
  }
  return `
    <button class="btn btn-primary" onclick="signInCloudAccount()" ${authDisabled ? 'disabled' : ''}>${isLoading ? 'Logging in...' : 'Login'}</button>
    <button class="btn" onclick="setCloudAuthMode('signup')" ${authDisabled ? 'disabled' : ''}>Create account</button>
  `;
}

async function checkForAppUpdate() {
  const updateState = getAppUpdateState();
  if (updateState.checking || updateState.installing) return;

  updateState.checking = true;
  updateState.notice = '';
  updateState.noticeTone = 'blue';
  if (state.screen === 'settings') await renderInPlace();

  try {
    const update = await invoke('check_for_app_update');
    updateState.checkedAt = new Date().toISOString();
    if (update) {
      updateState.availableVersion = update.version || '';
      updateState.availableNotes = update.notes || '';
      updateState.availableDate = update.pubDate || '';
      updateState.notice = `Version ${update.version} is available. You can install it from this screen.`;
      updateState.noticeTone = 'amber';
      toast(`Update available: ${update.version}`);
    } else {
      updateState.availableVersion = '';
      updateState.availableNotes = '';
      updateState.availableDate = '';
      updateState.notice = `You already have the latest version (${updateState.currentVersion || 'current build'}).`;
      updateState.noticeTone = 'green';
      toast('No updates found');
    }
  } catch (error) {
    updateState.notice = String(error);
    updateState.noticeTone = 'red';
  } finally {
    updateState.checking = false;
    if (state.screen === 'settings') await renderInPlace();
  }
}

async function installAppUpdate() {
  const updateState = getAppUpdateState();
  if (updateState.installing || !updateState.availableVersion) return;

  updateState.installing = true;
  updateState.notice = `Installing version ${updateState.availableVersion}...`;
  updateState.noticeTone = 'blue';
  if (state.screen === 'settings') await renderInPlace();

  try {
    await invoke('install_app_update');
    updateState.availableVersion = '';
    updateState.availableNotes = '';
    updateState.availableDate = '';
    updateState.notice = 'Update installed. Restart the app to finish applying it. On Windows the app may close automatically during installation.';
    updateState.noticeTone = 'green';
    toast('Update installed');
  } catch (error) {
    updateState.notice = String(error);
    updateState.noticeTone = 'red';
  } finally {
    updateState.installing = false;
    if (state.screen === 'settings') await renderInPlace();
  }
}

function renderAuthGate() {
  const cloud = getCloudSession();
  const cloudForm = getCloudFormState();
  const isLoading = Boolean(cloudForm.loading);
  const authDisabled = !cloud.configured || isLoading;
  const copy = getCloudAuthModeCopy(cloudForm.mode);
  return `
    <div class="auth-gate-shell">
      <div class="auth-gate-panel">
        <div class="auth-gate-copy">
          <img class="auth-gate-logo" src="${BRAND_LOGO_SRC}" alt="Garage CRM" />
          <div class="auth-gate-eyebrow">Garage CRM</div>
          <h1 class="auth-gate-title">${escHtml(copy.title)}</h1>
        </div>

        <div class="auth-gate-card">
          ${renderCloudAuthNotice()}
          ${renderCloudAuthFields(cloudForm, authDisabled)}
          ${cloud.configured ? '' : '<div class="auth-gate-helper">Account login is not available yet. Contact support.</div>'}
          <div class="auth-gate-actions">
            ${renderCloudAuthActions(cloudForm, authDisabled, isLoading)}
          </div>
        </div>
      </div>
    </div>
  `;
}

// ── NAVIGATION ────────────────────────────────────────────────────────────
function renderSidebarNav() {
  const navEl = document.getElementById('sidebar-nav');
  if (!navEl) return;
  navEl.innerHTML = getOrderedNavItems().map(item => `
    <div
      class="nav-item${item.screen === state.screen ? ' active' : ''}"
      data-screen="${item.screen}"
      onclick="handleNavClick('${item.screen}')"
    >
      <div class="nav-main">
        <svg class="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="${item.path}"/></svg>
        <span class="nav-label">${item.label}</span>
      </div>
      <span class="nav-grip" aria-hidden="true" title="Drag to reorder" onclick="event.stopPropagation()" onpointerdown="handleNavPointerDown(event, '${item.screen}')">::</span>
    </div>
  `).join('');
  if (navPointerState?.sourceScreen) {
    document.querySelector(`.nav-item[data-screen="${navPointerState.sourceScreen}"]`)?.classList.add('is-dragging');
    if (navPointerState.overScreen && navPointerState.overScreen !== navPointerState.sourceScreen) {
      const overItem = document.querySelector(`.nav-item[data-screen="${navPointerState.overScreen}"]`);
      overItem?.classList.add('drag-over');
      overItem?.classList.add(navPointerState.insertAfter ? 'drag-after' : 'drag-before');
    }
  }
}

function handleNavClick(screen) {
  if (suppressNavClick) {
    suppressNavClick = false;
    return;
  }
  nav(screen);
}

function handleNavPointerDown(event, screen) {
  event.preventDefault();
  event.stopPropagation();
  navPointerState = {
    pointerId: event.pointerId,
    sourceScreen: screen,
    overScreen: screen,
    insertAfter: false,
    moved: false,
    orderChanged: false,
  };
  document.body.classList.add('nav-reordering');
  document.querySelector(`.nav-item[data-screen="${screen}"]`)?.classList.add('is-dragging');
}

function handleNavPointerMove(event) {
  if (!navPointerState || event.pointerId !== navPointerState.pointerId) return;
  event.preventDefault();
  const hoveredItem = document.elementFromPoint(event.clientX, event.clientY)?.closest('.nav-item');
  if (!hoveredItem) return;
  navPointerState.moved = true;
  const hoveredScreen = hoveredItem.dataset.screen;
  if (!hoveredScreen) return;
  const rect = hoveredItem.getBoundingClientRect();
  const insertAfter = event.clientY >= rect.top + rect.height / 2;
  const currentOrder = [...getNavOrder()];
  const withoutSource = currentOrder.filter(screen => screen !== navPointerState.sourceScreen);
  const hoveredIndex = withoutSource.indexOf(hoveredScreen);
  if (hoveredIndex === -1) return;
  const insertIndex = hoveredIndex + (insertAfter ? 1 : 0);
  const nextOrder = [...withoutSource];
  nextOrder.splice(insertIndex, 0, navPointerState.sourceScreen);
  navPointerState.overScreen = hoveredScreen;
  navPointerState.insertAfter = insertAfter;
  if (nextOrder.join('|') === currentOrder.join('|')) {
    renderSidebarNav();
    return;
  }
  setNavOrder(nextOrder);
  navPointerState.orderChanged = true;
  renderSidebarNav();
}

function handleNavPointerUp(event) {
  if (!navPointerState || event.pointerId !== navPointerState.pointerId) return;
  const { moved, orderChanged } = navPointerState;
  clearNavPointerState();
  if (!moved || !orderChanged) return;
  persistNavOrder(getNavOrder());
  toast('Menu order updated');
}

function clearNavPointerState() {
  navPointerState = null;
  document.body.classList.remove('nav-reordering');
  document.querySelectorAll('.nav-item.is-dragging, .nav-item.drag-over, .nav-item.drag-before, .nav-item.drag-after').forEach(el => {
    el.classList.remove('is-dragging');
    el.classList.remove('drag-over');
    el.classList.remove('drag-before');
    el.classList.remove('drag-after');
  });
}

function setTopbarPrimaryButton({ label, onClick, hidden = false }) {
  const pb = document.getElementById('primary-btn');
  if (!pb) return;
  pb.style.display = hidden ? 'none' : '';
  if (hidden) return;
  pb.textContent = label;
  pb.onclick = onClick;
}

function updateTopbarForScreen(screen = state.screen) {
  const titles = { dashboard:'Dashboard', admin:'Admin', clients:'Customers', vehicles:'Vehicles', jobs:'Jobs', invoices:'Invoices', reports:'Reports', inventory:'Inventory', calendar:'Calendar', messages:'Messages', billing:'Billing', settings:'Settings' };
  const titleEl = document.getElementById('topbar-title');
  if (titleEl) titleEl.textContent = titles[screen] || screen;
}

function resetToDashboardAfterLogin() {
  state.garageSetupMode = false;
  state.screen = 'dashboard';
  state.searchQuery = '';
  state.selectedClient = null;
  state.selectedJob = null;
  state.selectedInvoice = null;
  state.invoiceEditorId = null;
  state.invoiceCreateDraft = null;
  state.modalState = null;
  setMobileNavOpen(false);
}

function openGarageSetupAfterSignup() {
  state.garageSetupMode = true;
  state.screen = 'settings';
  state.settingsCategory = 'garage';
  state.searchQuery = '';
  state.selectedClient = null;
  state.selectedJob = null;
  state.selectedInvoice = null;
  state.invoiceEditorId = null;
  state.invoiceCreateDraft = null;
  state.modalState = null;
  setMobileNavOpen(false);
}

function rememberGarageSetupPending(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return;
  try {
    window.localStorage.setItem(GARAGE_SETUP_PENDING_EMAIL_STORAGE_KEY, normalizedEmail);
  } catch (error) {
    console.warn('Unable to remember garage setup state', error);
  }
}

function consumeGarageSetupPending(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return false;
  try {
    const pendingEmail = String(window.localStorage.getItem(GARAGE_SETUP_PENDING_EMAIL_STORAGE_KEY) || '').trim().toLowerCase();
    if (pendingEmail !== normalizedEmail) return false;
    window.localStorage.removeItem(GARAGE_SETUP_PENDING_EMAIL_STORAGE_KEY);
    return true;
  } catch (error) {
    console.warn('Unable to read garage setup state', error);
    return false;
  }
}

function setMobileNavOpen(open) {
  state.mobileNavOpen = Boolean(open);
  const app = document.getElementById('app');
  app?.classList.toggle('mobile-nav-open', state.mobileNavOpen);
  const toggle = document.getElementById('mobile-menu-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', state.mobileNavOpen ? 'true' : 'false');
}

function toggleMobileNav() {
  setMobileNavOpen(!state.mobileNavOpen);
}

function closeMobileNav() {
  setMobileNavOpen(false);
}

async function nav(screen) {
  if (screen === 'billing') {
    state.settingsCategory = 'billing';
    screen = 'settings';
  }
  const previousScreen = state.screen;
  if (!isCloudSignedIn() && screen !== 'settings') {
    if (screen === 'admin') setRouteForScreen('dashboard', { replace: true });
    setSignedOutWorkspaceNotice();
    screen = 'settings';
  }
  if (screen === 'admin') {
    const isAdmin = await ensureAdminAccess();
    if (!isAdmin) {
      resetAdminStats();
      screen = 'dashboard';
      setRouteForScreen('dashboard', { replace: true });
    }
  }
  if (screen !== previousScreen) state.searchQuery = '';
  state.screen = screen;
  setRouteForScreen(screen);
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.screen === screen));
  updateTopbarForScreen(screen);
  closeMobileNav();
  await render();
}

function primaryAction(screen) {
  if (!isCloudSignedIn() && screen !== 'settings') {
    setSignedOutWorkspaceNotice();
    nav('settings');
    return;
  }
  if (screen === 'clients') showClientModal();
  else if (screen === 'vehicles') showVehicleModal();
  else if (screen === 'jobs') showJobModal();
  else if (screen === 'invoices') showInvoiceCreateModal();
  else if (screen === 'inventory') showInventoryItemModal();
  else if (screen === 'calendar') showBookingFlow();
  else if (screen === 'messages') showSmsComposeModal();
  else if (screen === 'dashboard') showJobModal();
  else if (screen === 'settings') saveSettings();
}

// ── DATA LOADING ──────────────────────────────────────────────────────────
async function invokeForLoad(command, args, fallback) {
  try {
    return args === undefined ? await invoke(command) : await invoke(command, args);
  } catch (error) {
    console.warn(`Unable to load ${command}`, error);
    return fallback;
  }
}

async function loadBusinessStateFromBackend() {
  const [clients, vehicles, jobs, invoices, bookings, workers, allJobLines, inventoryItems, inventoryMovements, messageSettings, messageLog, nextSettings, nextCloud, nextAppUpdateMeta] = await Promise.all([
    invokeForLoad('get_clients', undefined, state.clients || []),
    invokeForLoad('get_vehicles', {clientId: null}, state.vehicles || []),
    invokeForLoad('get_job_cards', undefined, state.jobs || []),
    invokeForLoad('get_invoices', undefined, state.invoices || []),
    invokeForLoad('get_bookings', undefined, state.bookings || []),
    invokeForLoad('get_workers', undefined, state.workers || []),
    invokeForLoad('get_all_job_lines', undefined, state.allJobLines || []),
    invokeForLoad('get_inventory_items', undefined, state.inventoryItems || []),
    invokeForLoad('get_inventory_movements', undefined, state.inventoryMovements || []),
    invokeForLoad('get_message_settings', undefined, state.messageSettings),
    invokeForLoad('get_message_log', { limit: 100 }, state.messageLog || []),
    invokeForLoad('get_app_settings', undefined, state.settings),
    invokeForLoad('get_cloud_account_status', undefined, state.cloud),
    invokeForLoad('get_app_update_state', undefined, state.appUpdate)
  ]);
  state.clients = clients;
  state.vehicles = vehicles;
  state.jobs = jobs;
  state.invoices = invoices;
  state.bookings = bookings;
  state.workers = workers;
  state.allJobLines = allJobLines;
  state.inventoryItems = inventoryItems;
  state.inventoryMovements = inventoryMovements;
  state.messageSettings = messageSettings;
  state.messageLog = messageLog;
  state.settings = nextSettings;
  state.cloud = nextCloud;
  state.appUpdate = { ...getAppUpdateState(), ...(nextAppUpdateMeta || {}) };
}

async function loadAll() {
  const [settings, cloud, appUpdateMeta] = await Promise.all([
    invokeForLoad('get_app_settings', undefined, getSettings()),
    invokeForLoad('get_cloud_account_status', undefined, getCloudSession()),
    invokeForLoad('get_app_update_state', undefined, getAppUpdateState())
  ]);
  state.settings = settings;
  state.cloud = cloud;
  state.appUpdate = { ...getAppUpdateState(), ...(appUpdateMeta || {}) };

  if (!isCloudSignedIn()) {
    clearLoadedBusinessState();
    state.cloudHydratedUserId = '';
    return;
  }

  try {
    await restoreCloudWorkspace();
    await refreshCloudWorkspaceIfRemoteChanged();
  } catch (error) {
    console.warn('Unable to restore cloud workspace during startup', error);
    setCloudAuthNotice('Could not refresh from cloud. Showing local data where available.', 'amber');
  }

  await loadBusinessStateFromBackend();
  try {
    await processAutomaticSmsReminders();
  } catch (error) {
    console.warn('Automatic SMS reminders skipped during startup', error);
  }
}

let supabaseAuthInitialized = false;
let deepLinkInitialized = false;

function normalizeDeepLinkUrls(payload) {
  const urls = [];
  const append = value => {
    if (!value) return;
    if (typeof value === 'string') {
      urls.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(append);
      return;
    }
    if (typeof value === 'object') {
      append(value.url);
      append(value.urls);
    }
  };

  append(payload);
  return [...new Set(urls.map(url => String(url)).filter(Boolean))];
}

async function handleGarageDeepLinks(payload) {
  const urls = normalizeDeepLinkUrls(payload)
    .filter(url => url.toLowerCase().startsWith('garagecrm://auth/callback'));
  if (!urls.length) return false;

  const form = getCloudFormState();
  try {
    for (const url of urls) {
      const result = await handleAuthCallbackUrl(url);
      if (result === 'recovery') {
        form.mode = 'reset';
        form.password = '';
        form.confirmPassword = '';
        form.verificationCode = '';
        state.screen = 'settings';
        setCloudAuthNotice('Password recovery link opened. Enter a new password.', 'green');
        await refreshCloudAccountStatus();
        await render();
        return true;
      }
    }
  } catch (error) {
    form.mode = 'login';
    form.password = '';
    form.confirmPassword = '';
    state.screen = 'settings';
    setCloudAuthNotice(getErrorMessage(error), 'red');
    await render();
    return true;
  }

  return false;
}

async function initializeDeepLinks() {
  if (deepLinkInitialized) return;
  deepLinkInitialized = true;

  try {
    await listen('deep-link://new-url', event => {
      void handleGarageDeepLinks(event.payload);
    });
  } catch (error) {
    console.warn('Unable to listen for account recovery links', error);
  }

  try {
    const currentUrls = await invoke('plugin:deep-link|get_current');
    await handleGarageDeepLinks(currentUrls);
  } catch (error) {
    console.warn('Unable to read startup account recovery link', error);
  }
}

async function refreshCloudAccountStatus() {
  try {
    state.cloud = await invoke('get_cloud_account_status');
  } catch (error) {
    console.warn('Unable to refresh cloud account status', error);
  }
}

async function initializeSupabaseAuth() {
  if (supabaseAuthInitialized) return;
  supabaseAuthInitialized = true;
  const callbackError = isAuthCallbackRoute() ? getAuthCallbackError() : '';

  onSupabaseAuthStateChange(async (event, session) => {
    if (session || event === 'SIGNED_OUT') {
      await refreshCloudAccountStatus();
    }
  });

  await initializeDeepLinks();

  try {
    if (getCloudFormState().mode !== 'reset') {
      await getSupabaseSession();
    }
    await refreshCloudAccountStatus();
  } catch (error) {
    console.warn('Unable to restore account auth session', error);
    setCloudAuthNotice(getErrorMessage(error), 'red');
  }

  if (isAuthCallbackRoute()) {
    if (callbackError) {
      setCloudAuthNotice(callbackError, 'red');
    } else {
      setCloudAuthNotice('Email verified. Return to Garage CRM and log in.', 'green');
    }
    clearAuthCallbackUrl();
  }
}

// ── RENDER ROUTER ─────────────────────────────────────────────────────────
function renderAppRecovery(error) {
  console.error('Garage CRM render failed', error);
  const app = document.getElementById('app');
  const authGate = document.getElementById('auth-gate');
  const c = document.getElementById('content');
  if (!app || !c) return;

  state.screen = 'settings';
  app.classList.remove('auth-only');
  if (authGate) authGate.innerHTML = '';
  try { renderSidebarNav(); } catch (navError) { console.warn('Unable to render sidebar during recovery', navError); }
  const titleEl = document.getElementById('topbar-title');
  if (titleEl) titleEl.textContent = 'Startup recovery';
  setTopbarPrimaryButton({ hidden: true });
  c.innerHTML = `
    <div class="card settings-card">
      <div class="settings-card-head">
        <div>
          <div class="settings-kicker">Recovery</div>
          <div class="settings-title">Garage CRM could not finish loading</div>
        </div>
        <span class="badge badge-amber">Needs attention</span>
      </div>
      <div class="auth-note auth-note-amber" style="margin:0 0 12px">
        ${escHtml(getErrorMessage(error))}
      </div>
      <p class="text-muted" style="margin-top:0">Your local data has not been deleted. Try loading again, or install the latest update manually if this is an older app version.</p>
      <div class="settings-actions">
        <button class="btn btn-primary" onclick="retryAppRender()">Retry</button>
        <button class="btn" onclick="checkForAppUpdate()">Check for update</button>
      </div>
    </div>
  `;
  applyLanguageToDom(c);
}

async function retryAppRender() {
  await render();
}

async function render() {
  try {
    const app = document.getElementById('app');
    const authGate = document.getElementById('auth-gate');
    const c = document.getElementById('content');
    await loadAll();
    if (!isCloudSignedIn()) {
      resetAdminAccess();
      if (isAdminRoutePath()) setRouteForScreen('dashboard', { replace: true });
      state.screen = 'settings';
      setSignedOutWorkspaceNotice();
      setMobileNavOpen(false);
      app.classList.add('auth-only');
      authGate.innerHTML = renderAuthGate();
      applyLanguageToDom(authGate);
      bindEvents();
      return;
    }
    await ensureAdminAccess();
    if (state.screen === 'admin' && !isCurrentUserAdmin()) {
      resetAdminStats();
      state.screen = 'dashboard';
      setRouteForScreen('dashboard', { replace: true });
    }
    app.classList.remove('auth-only');
    authGate.innerHTML = '';
    renderSidebarNav();
    setMobileNavOpen(state.mobileNavOpen);
    updateTopbarForScreen(state.screen);
    applyAppSettingsToChrome();
    if (state.screen === 'dashboard') c.innerHTML = renderDashboard();
    else if (state.screen === 'admin') c.innerHTML = renderAdminScreenContent();
    else if (state.screen === 'clients') { if (state.selectedClient) c.innerHTML = renderClientProfile(); else c.innerHTML = renderClients(); }
    else if (state.screen === 'vehicles') c.innerHTML = renderVehicles();
    else if (state.screen === 'jobs') { if (state.selectedJob !== null) c.innerHTML = await renderJobCard(); else c.innerHTML = renderJobs(); }
    else if (state.screen === 'invoices') c.innerHTML = await renderInvoices();
    else if (state.screen === 'reports') c.innerHTML = renderReports();
    else if (state.screen === 'inventory') c.innerHTML = renderInventory();
    else if (state.screen === 'calendar') c.innerHTML = renderCalendarView();
    else if (state.screen === 'messages') c.innerHTML = renderMessages();
    else if (state.screen === 'billing') c.innerHTML = await renderBilling();
    else if (state.screen === 'settings') c.innerHTML = await renderSettings();
    restorePersistentModal();
    applyLanguageToDom(document);
    bindEvents();
    applyPendingFocus();
  } catch (error) {
    renderAppRecovery(error);
  }
}

// ── DASHBOARD ─────────────────────────────────────────────────────────────
function renderLegacyDashboard() {
  const active = state.jobs.filter(j => !['Completed','Cancelled'].includes(j.status));
  const unpaid = state.invoices.filter(i => getInvoiceBalanceDue(i, getInvoiceTotalAmount(i)) > 0);
  const todayRevenue = state.invoices.reduce((sum, invoice) => sum + getInvoicePaidAmount(invoice, getInvoiceTotalAmount(invoice)), 0);
  const today = new Date().toISOString().slice(0,10);
  const todayBookings = state.bookings.filter(b => b.date === today && b.status !== 'Cancelled');
  const recentJobs = [...state.jobs].slice(0,5);
  const recentInvoices = [...state.invoices].slice(0,5);

  return `
  <div class="metrics">
    <div class="metric blue"><div class="metric-label">Cars in service</div><div class="metric-val">${active.length}</div><div class="metric-sub">${active.filter(j=>j.status==='Waiting Parts').length} waiting parts</div></div>
    <div class="metric amber"><div class="metric-label">Open jobs</div><div class="metric-val">${active.length}</div><div class="metric-sub">${state.jobs.filter(j=>j.status==='Ready').length} ready for collection</div></div>
    <div class="metric red"><div class="metric-label">Unpaid invoices</div><div class="metric-val">${unpaid.length}</div><div class="metric-sub">${fmt(unpaid.reduce((s,i)=>s+getInvoiceBalanceDue(i,getInvoiceTotalAmount(i)),0))} outstanding</div></div>
    <div class="metric green"><div class="metric-label">Total paid</div><div class="metric-val">${fmt(todayRevenue)}</div><div class="metric-sub">${state.invoices.filter(i=>getInvoiceBalanceDue(i,getInvoiceTotalAmount(i))<=0).length} invoices paid</div></div>
  </div>
  <div class="two-col">
    <div>
      <div class="card">
        <div class="card-header"><span class="card-title">Active jobs</span><span class="badge badge-blue">${active.length} open</span></div>
        ${active.length === 0 ? '<div class="empty-state"><div class="icon">✓</div>No active jobs</div>' : active.map(j => `
        <div style="padding:10px 0;border-bottom:0.5px solid var(--border);cursor:pointer" onclick="openJob(${j.id})">
          <div class="flex gap-8" style="justify-content:space-between">
            <div><div style="font-size:13px;font-weight:500">${escHtml(j.registration)} — ${escHtml(j.make)} ${escHtml(j.model)}</div>
            <div class="text-sm text-muted">${escHtml(j.client_name)} · ${escHtml(j.complaint||'').slice(0,40)}</div></div>
            ${statusBadge(j.status)}
          </div>
          <div class="progress"><div class="progress-fill" style="width:${progressPct(j.status)}%"></div></div>
        </div>`).join('')}
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">Today's bookings</span><span class="badge badge-gray">${todayBookings.length}</span></div>
        ${todayBookings.length === 0 ? '<div class="text-sm text-muted" style="padding:8px 0">No bookings today</div>' : `
        <table><thead><tr><th>Time</th><th>Customer</th><th>Vehicle</th><th>Reason</th><th>Status</th></tr></thead><tbody>
        ${todayBookings.map(b=>`<tr><td>${escHtml(b.time)}</td><td>${escHtml(b.client_name)}</td><td>${escHtml(getBookingVehicleSummary(b))}</td><td>${escHtml(b.reason)}</td><td>${statusBadge(b.status)}</td></tr>`).join('')}
        </tbody></table>`}
      </div>
    </div>
    <div>
      <div class="card">
        <div class="card-header"><span class="card-title">Recent invoices</span></div>
        <table><thead><tr><th>#</th><th>Customer</th><th>Total</th><th>Status</th></tr></thead><tbody>
        ${recentInvoices.map(i => {
          const invoiceTotal = getInvoiceTotalAmount(i);
          const paidAmount = getInvoicePaidAmount(i, invoiceTotal);
          const balanceDue = getInvoiceBalanceDue(i, invoiceTotal);
          const displayStatus = balanceDue <= 0 ? 'Paid' : (paidAmount > 0 ? 'Partial' : i.status);
          return `<tr class="clickable" onclick="nav('invoices')"><td>${escHtml(i.invoice_number)}</td><td>${escHtml(i.client_name)}</td><td>${fmt(invoiceTotal)}</td><td>${statusBadge(displayStatus)}</td></tr>`;
        }).join('')}
        </tbody></table>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">Recent customers</span></div>
        <table><thead><tr><th>Name</th><th>Last visit</th><th>Balance</th></tr></thead><tbody>
        ${state.clients.slice(0,5).map(c=>`<tr class="clickable" onclick="openClient(${c.id})"><td>${escHtml(c.name)}</td><td>${fmtDate(c.last_visit)}</td><td class="${c.balance>0?'text-red':''}">${c.balance>0?fmt(c.balance):'—'}</td></tr>`).join('')}
        </tbody></table>
      </div>
    </div>
  </div>`;
}

const DASHBOARD_STATUS_ORDER = ['Booked', 'In Progress', 'Waiting for Parts', 'Completed', 'Invoiced', 'Paid', 'Cancelled'];
const DASHBOARD_STATUS_COLORS = {
  Booked: '#185FA5',
  'In Progress': '#2F6FAD',
  'Waiting for Parts': '#B7791F',
  Completed: '#3B6D11',
  Invoiced: '#5B6B84',
  Paid: '#2F7D32',
  Cancelled: '#8E8B84',
};

function addDashboardDays(date, amount) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function startOfDashboardWeek(date) {
  const start = new Date(date);
  const day = start.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + diff);
  return start;
}

function getDashboardDateRange(filter = state.dashboardDateFilter) {
  const today = new Date();
  const key = ['today', 'week', 'month', 'year'].includes(filter) ? filter : 'month';
  let start;
  let end;
  if (key === 'today') {
    start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    end = new Date(start);
  } else if (key === 'week') {
    start = startOfDashboardWeek(today);
    end = addDashboardDays(start, 6);
  } else if (key === 'year') {
    start = new Date(today.getFullYear(), 0, 1);
    end = new Date(today.getFullYear(), 11, 31);
  } else {
    start = new Date(today.getFullYear(), today.getMonth(), 1);
    end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  }
  return {
    key,
    start,
    end,
    startIso: formatDateInputValue(start),
    endIso: formatDateInputValue(end),
  };
}

function getPreviousDashboardDateRange(range) {
  const key = range.key;
  let start;
  let end;
  if (key === 'today') {
    start = addDashboardDays(range.start, -1);
    end = addDashboardDays(range.end, -1);
  } else if (key === 'week') {
    start = addDashboardDays(range.start, -7);
    end = addDashboardDays(range.end, -7);
  } else if (key === 'year') {
    start = new Date(range.start.getFullYear() - 1, 0, 1);
    end = new Date(range.start.getFullYear() - 1, 11, 31);
  } else {
    start = new Date(range.start.getFullYear(), range.start.getMonth() - 1, 1);
    end = new Date(range.start.getFullYear(), range.start.getMonth(), 0);
  }
  return {
    key,
    start,
    end,
    startIso: formatDateInputValue(start),
    endIso: formatDateInputValue(end),
  };
}

function normalizeDashboardDateText(value) {
  const text = String(value || '').trim();
  const isoDate = text.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(isoDate) ? isoDate : text;
}

function isDashboardDateInRange(dateText, range, includeMissing = false) {
  const normalized = normalizeDashboardDateText(dateText);
  if (!normalized) return includeMissing;
  return normalized >= range.startIso && normalized <= range.endIso;
}

function getDashboardRangeDisplay(range) {
  if (range.key === 'today') {
    return range.start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  if (range.key === 'month') {
    return range.start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  }
  if (range.key === 'year') {
    return String(range.start.getFullYear());
  }
  const start = range.start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const end = range.end.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return `${start} - ${end}`;
}

function getDashboardRangeCopy(range) {
  const map = {
    today: {
      bookingTitle: "Today's Bookings",
      revenueTitle: "Today's Revenue",
      bookingSubtitle: 'booked today',
      noBookings: 'No bookings today',
      revenueEmpty: 'No revenue recorded today',
      invoiceSubtitle: 'due or issued today',
    },
    week: {
      bookingTitle: "This Week's Bookings",
      revenueTitle: "This Week's Revenue",
      bookingSubtitle: 'booked this week',
      noBookings: 'No bookings this week',
      revenueEmpty: 'No revenue recorded this week',
      invoiceSubtitle: 'due or issued this week',
    },
    month: {
      bookingTitle: "This Month's Bookings",
      revenueTitle: 'Monthly Revenue',
      bookingSubtitle: 'booked this month',
      noBookings: 'No bookings this month',
      revenueEmpty: 'No revenue recorded this month',
      invoiceSubtitle: 'due or issued this month',
    },
    year: {
      bookingTitle: "This Year's Bookings",
      revenueTitle: 'Yearly Revenue',
      bookingSubtitle: 'booked this year',
      noBookings: 'No bookings this year',
      revenueEmpty: 'No revenue recorded this year',
      invoiceSubtitle: 'due or issued this year',
    },
  };
  return map[range.key] || map.month;
}

function getDashboardMockData() {
  const today = new Date();
  const todayIso = formatDateInputValue(today);
  const year = today.getFullYear();
  const month = today.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const revenuePattern = [0, 540, 680, 320, 950, 0, 0, 760, 1120, 430, 610, 1280, 0, 0, 890, 1010, 740, 360, 1180, 0, 0, 930, 1540, 670, 720, 1090, 0, 0, 860, 1240, 980];
  const revenueData = Array.from({ length: daysInMonth }, (_, index) => ({
    date: formatDateInputValue(new Date(year, month, index + 1)),
    revenue: revenuePattern[index] || 0,
  }));
  const bookings = [
    { id: 'mock-b-1', date: todayIso, time: '09:00', customer: 'John Smith', vehicle: 'BMW 320d', service: 'Full Service', status: 'Booked' },
    { id: 'mock-b-2', date: todayIso, time: '10:30', customer: 'Sarah Jones', vehicle: 'Ford Fiesta', service: 'MOT', status: 'Booked' },
    { id: 'mock-b-3', date: todayIso, time: '13:00', customer: 'Mark Brown', vehicle: 'Audi A4', service: 'Brake Pads', status: 'Waiting for Parts' },
    { id: 'mock-b-4', date: formatDateInputValue(addDashboardDays(today, 1)), time: '08:30', customer: 'Amelia Patel', vehicle: 'VW Golf', service: 'Diagnostics', status: 'Booked' },
    { id: 'mock-b-5', date: formatDateInputValue(addDashboardDays(today, 2)), time: '11:00', customer: 'Premier Couriers', vehicle: 'Ford Transit', service: 'Clutch Inspection', status: 'Booked' },
  ];
  const jobs = [
    { id: 'J-1048', customer: 'John Smith', vehicle: 'BMW 320d', service: 'Full Service', status: 'Booked' },
    { id: 'J-1047', customer: 'Sarah Jones', vehicle: 'Ford Fiesta', service: 'MOT', status: 'Booked' },
    { id: 'J-1046', customer: 'Mark Brown', vehicle: 'Audi A4', service: 'Brake Pads', status: 'Waiting for Parts' },
    { id: 'J-1045', customer: 'Amelia Patel', vehicle: 'VW Golf', service: 'Diagnostics', status: 'In Progress' },
    { id: 'J-1044', customer: 'Premier Couriers', vehicle: 'Ford Transit', service: 'Clutch Inspection', status: 'Waiting for Parts' },
    { id: 'J-1043', customer: 'Oliver Green', vehicle: 'Nissan Qashqai', service: 'Oil Leak', status: 'Completed' },
    { id: 'J-1042', customer: 'Hannah Wilson', vehicle: 'Mini Cooper', service: 'Suspension', status: 'Invoiced' },
    { id: 'J-1041', customer: 'Tom Evans', vehicle: 'Vauxhall Astra', service: 'Cambelt', status: 'Paid' },
  ];
  const invoices = [
    { id: 'mock-i-1', invoice_number: 'INV-1042', customer: 'John Smith', vehicle: 'BMW 320d', amount: 420, total: 420, due_date: formatDateInputValue(addDashboardDays(today, 2)), date_issued: todayIso, status: 'Pending' },
    { id: 'mock-i-2', invoice_number: 'INV-1041', customer: 'Sarah Jones', vehicle: 'Ford Fiesta', amount: 180, total: 180, due_date: formatDateInputValue(addDashboardDays(today, -3)), date_issued: formatDateInputValue(addDashboardDays(today, -7)), status: 'Overdue' },
    { id: 'mock-i-3', invoice_number: 'INV-1039', customer: 'Premier Couriers', vehicle: 'Ford Transit', amount: 680, total: 680, due_date: formatDateInputValue(addDashboardDays(today, -6)), date_issued: formatDateInputValue(addDashboardDays(today, -12)), status: 'Overdue' },
    { id: 'mock-i-4', invoice_number: 'INV-1038', customer: 'Tom Evans', vehicle: 'Vauxhall Astra', amount: 540, total: 540, due_date: formatDateInputValue(addDashboardDays(today, -1)), date_issued: formatDateInputValue(addDashboardDays(today, -11)), status: 'Paid' },
  ];
  const stockItems = [
    { id: 'mock-s-1', partName: 'Engine Oil 5W30', category: 'Fluids', currentStock: 4, reorderLevel: 12, status: 'Low' },
    { id: 'mock-s-2', partName: 'Brake Pads', category: 'Braking', currentStock: 2, reorderLevel: 8, status: 'Critical' },
    { id: 'mock-s-3', partName: 'Oil Filter', category: 'Service Parts', currentStock: 3, reorderLevel: 10, status: 'Low' },
    { id: 'mock-s-4', partName: 'Bulbs', category: 'Electrical', currentStock: 6, reorderLevel: 15, status: 'Low' },
    { id: 'mock-s-5', partName: 'Wiper Blades', category: 'Service Parts', currentStock: 5, reorderLevel: 12, status: 'Low' },
  ];
  const jobStatusData = [
    { status: 'Booked', count: 4 },
    { status: 'In Progress', count: 3 },
    { status: 'Waiting for Parts', count: 2 },
    { status: 'Completed', count: 5 },
    { status: 'Invoiced', count: 2 },
    { status: 'Paid', count: 6 },
    { status: 'Cancelled', count: 1 },
  ];
  const reminders = [
    { id: 'mock-r-1', customer: 'John Smith', vehicle: 'BMW 320d', type: 'Service reminder', dueDate: todayIso },
    { id: 'mock-r-2', customer: 'Sarah Jones', vehicle: 'Ford Fiesta', type: 'MOT reminder', dueDate: formatDateInputValue(addDashboardDays(today, 2)) },
    { id: 'mock-r-3', customer: 'Mark Brown', vehicle: 'Audi A4', type: 'Follow-up call', dueDate: formatDateInputValue(addDashboardDays(today, 4)) },
    { id: 'mock-r-4', customer: 'Amelia Patel', vehicle: 'VW Golf', type: 'Service reminder', dueDate: formatDateInputValue(addDashboardDays(today, 5)) },
  ];
  const previousMonthRevenue = Math.round(revenueData.reduce((sum, item) => sum + item.revenue, 0) / 1.12);
  return { bookings, jobs, invoices, stockItems, revenueData, jobStatusData, reminders, previousMonthRevenue };
}

function getDashboardData() {
  const hasConnectedBusinessData = true;
  const bookings = Array.isArray(state.bookings) ? state.bookings : [];
  const jobs = Array.isArray(state.jobs) ? state.jobs : [];
  const invoices = Array.isArray(state.invoices) ? state.invoices : [];
  const stockItems = getInventoryItems();
  const inventoryMovements = getInventoryMovements();
  const reminders = Array.isArray(state.reminders) ? state.reminders : [];
  const revenueData = buildRevenueDataFromInvoices(invoices);
  const previousMonthRevenue = getInvoiceRevenueForMonth(invoices, -1);
  const jobStatusData = buildJobStatusDataFromJobs(jobs, invoices);
  return { bookings, jobs, invoices, stockItems, inventoryMovements, revenueData, jobStatusData, reminders, previousMonthRevenue, hasConnectedBusinessData };
}

function getDashboardInvoiceAmount(invoice) {
  return Number(invoice?.amount ?? invoice?.total ?? invoice?.subtotal ?? 0) || 0;
}

function getDashboardInvoiceBalance(invoice) {
  return getInvoiceBalanceDue(invoice, getDashboardInvoiceAmount(invoice));
}

function getDashboardInvoicePaidAmount(invoice) {
  return getInvoicePaidAmount(invoice, getDashboardInvoiceAmount(invoice));
}

function getDashboardJobDate(job) {
  return job?.date_opened || job?.date || job?.booking_date || job?.created_at || '';
}

function getDashboardReminderDate(reminder) {
  return reminder?.dueDate || reminder?.due_date || reminder?.date || '';
}

function getDashboardInvoiceRangeDate(invoice) {
  return invoice?.due_date || getDashboardInvoiceDate(invoice);
}

function getDashboardInvoiceDate(invoice) {
  return invoice?.date_paid || invoice?.paid_at || invoice?.date_issued || invoice?.date || invoice?.due_date || '';
}

function isDashboardPaid(invoice) {
  return getDashboardInvoiceBalance(invoice) <= 0 || String(invoice?.status || '').toLowerCase() === 'paid';
}

function getDashboardInvoiceStatus(invoice) {
  const raw = String(invoice?.status || 'Pending').trim();
  const paidAmount = getDashboardInvoicePaidAmount(invoice);
  if (getDashboardInvoiceBalance(invoice) <= 0 || raw.toLowerCase() === 'paid') return 'Paid';
  const dueDate = normalizeDashboardDateText(invoice?.due_date);
  if (dueDate && dueDate < formatDateInputValue()) return 'Overdue';
  if (raw.toLowerCase() === 'partial' || raw.toLowerCase() === 'part paid' || paidAmount > 0) return 'Partial';
  if (raw.toLowerCase() === 'overdue') return 'Overdue';
  return 'Pending';
}

function isDashboardOutstandingInvoice(invoice) {
  return getDashboardInvoiceBalance(invoice) > 0;
}

function getInvoiceRevenueForMonth(invoices, monthOffset = 0) {
  const target = new Date();
  target.setMonth(target.getMonth() + monthOffset, 1);
  const targetYear = target.getFullYear();
  const targetMonth = target.getMonth();
  return invoices
    .filter(invoice => getDashboardInvoicePaidAmount(invoice) > 0)
    .filter(invoice => {
      const dateText = getDashboardInvoiceDate(invoice);
      if (!dateText) return false;
      const invoiceDate = new Date(`${dateText}T00:00:00`);
      return invoiceDate.getFullYear() === targetYear && invoiceDate.getMonth() === targetMonth;
    })
    .reduce((sum, invoice) => sum + getDashboardInvoicePaidAmount(invoice), 0);
}

function buildRevenueDataFromInvoices(invoices) {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daily = Array.from({ length: daysInMonth }, (_, index) => ({
    date: formatDateInputValue(new Date(year, month, index + 1)),
    revenue: 0,
  }));
  invoices
    .filter(invoice => getDashboardInvoicePaidAmount(invoice) > 0)
    .forEach(invoice => {
      const dateText = getDashboardInvoiceDate(invoice);
      if (!dateText) return;
      const invoiceDate = new Date(`${dateText}T00:00:00`);
      if (invoiceDate.getFullYear() !== year || invoiceDate.getMonth() !== month) return;
      const dayIndex = invoiceDate.getDate() - 1;
      if (daily[dayIndex]) daily[dayIndex].revenue += getDashboardInvoicePaidAmount(invoice);
    });
  return daily;
}

function buildDashboardRevenueBuckets(range) {
  if (range.key === 'year') {
    return Array.from({ length: 12 }, (_, month) => {
      const date = new Date(range.start.getFullYear(), month, 1);
      return {
        key: formatDateInputValue(date).slice(0, 7),
        date: formatDateInputValue(date),
        label: date.toLocaleDateString('en-GB', { month: 'short' }),
        revenue: 0,
      };
    });
  }
  const days = [];
  for (let cursor = new Date(range.start); cursor <= range.end; cursor = addDashboardDays(cursor, 1)) {
    const date = formatDateInputValue(cursor);
    days.push({ key: date, date, revenue: 0 });
  }
  return days;
}

function buildDashboardRevenueDataForRange(data, range) {
  const buckets = buildDashboardRevenueBuckets(range);
  const bucketMap = new Map(buckets.map(bucket => [bucket.key, bucket]));
  if (data.hasConnectedBusinessData) {
    data.invoices
      .filter(invoice => getDashboardInvoicePaidAmount(invoice) > 0)
      .forEach(invoice => {
        const dateText = normalizeDashboardDateText(getDashboardInvoiceDate(invoice));
        if (!isDashboardDateInRange(dateText, range)) return;
        const bucketKey = range.key === 'year' ? dateText.slice(0, 7) : dateText;
        const bucket = bucketMap.get(bucketKey);
        if (bucket) bucket.revenue += getDashboardInvoicePaidAmount(invoice);
      });
    return buckets;
  }
  data.revenueData.forEach(item => {
    const dateText = normalizeDashboardDateText(item.date);
    if (!isDashboardDateInRange(dateText, range)) return;
    const bucketKey = range.key === 'year' ? dateText.slice(0, 7) : dateText;
    const bucket = bucketMap.get(bucketKey);
    if (bucket) bucket.revenue += Number(item.revenue) || 0;
  });
  return buckets;
}

function getDashboardRevenueTotalForRange(data, range) {
  return buildDashboardRevenueDataForRange(data, range).reduce((sum, item) => sum + (Number(item.revenue) || 0), 0);
}

function normalizeDashboardJobStatus(job, invoices = []) {
  const invoice = invoices.find(item => String(item.job_id || '') === String(job?.id || ''));
  if (invoice && isDashboardPaid(invoice)) return 'Paid';
  if (invoice) return 'Invoiced';
  const raw = String(job?.status || 'Booked').trim();
  const map = {
    New: 'Booked',
    Confirmed: 'Booked',
    Booked: 'Booked',
    Diagnosing: 'In Progress',
    'In Progress': 'In Progress',
    'Waiting Parts': 'Waiting for Parts',
    'Waiting for Parts': 'Waiting for Parts',
    Ready: 'Completed',
    Completed: 'Completed',
    Invoiced: 'Invoiced',
    Paid: 'Paid',
    Cancelled: 'Cancelled',
  };
  return map[raw] || 'Booked';
}

function buildJobStatusDataFromJobs(jobs, invoices = []) {
  const counts = Object.fromEntries(DASHBOARD_STATUS_ORDER.map(status => [status, 0]));
  jobs.forEach(job => {
    const status = normalizeDashboardJobStatus(job, invoices);
    counts[status] = (counts[status] || 0) + 1;
  });
  return DASHBOARD_STATUS_ORDER.map(status => ({ status, count: counts[status] || 0 }));
}

function getDashboardBookingDate(booking) {
  return booking?.date || booking?.booking_date || '';
}

function getDashboardBookingTime(booking) {
  return booking?.time || booking?.booking_time || '';
}

function getDashboardBookingCustomer(booking) {
  return booking?.customer || booking?.client_name || booking?.client || 'Walk-in customer';
}

function getDashboardBookingVehicle(booking) {
  if (booking?.vehicle) return booking.vehicle;
  return [booking?.registration, booking?.make, booking?.model].filter(Boolean).join(' ') || 'Vehicle TBC';
}

function getDashboardBookingService(booking) {
  return booking?.service || booking?.reason || booking?.service_type || 'Workshop booking';
}

function getDashboardBookingStatus(booking) {
  return booking?.status || 'Booked';
}

function getDashboardInvoiceCustomer(invoice) {
  return invoice?.customer || invoice?.client_name || invoice?.client || 'Customer';
}

function getDashboardInvoiceVehicle(invoice) {
  if (invoice?.vehicle) return invoice.vehicle;
  return [invoice?.registration, invoice?.make, invoice?.model].filter(Boolean).join(' ') || 'Vehicle TBC';
}

function getDashboardPartName(item) {
  return getInventoryPartName(item);
}

function getDashboardStockStatus(item) {
  if (item?.status) return item.status;
  return getInventoryStockStatus(item);
}

function isDashboardLowStock(item) {
  return getLowStockItems([item]).length > 0;
}

function formatDashboardMoneyShort(amount) {
  const currency = normalizeCurrency(getSettings().currency);
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
      notation: Math.abs(amount) >= 1000 ? 'compact' : 'standard',
      maximumFractionDigits: Math.abs(amount) >= 1000 ? 1 : 0,
    }).format(amount);
  } catch {
    return `${currency} ${Math.round(amount).toLocaleString('en-GB')}`;
  }
}

function formatDashboardDay(dateText) {
  if (!dateText) return '';
  const date = new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(date.getTime())) return escHtml(dateText);
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function formatDashboardRevenueComparison(current, previous, rangeCopy = null) {
  if (!previous) return current > 0 ? 'New revenue for this period' : (rangeCopy?.revenueEmpty || 'No revenue this period');
  const diff = Math.round(((current - previous) / previous) * 100);
  return `${diff >= 0 ? '+' : ''}${diff}% vs previous period`;
}

function dashboardPlural(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function dashboardIcon(name) {
  const icons = {
    calendar: '<rect x="3" y="4" width="18" height="17" rx="3"></rect><path d="M8 2v4M16 2v4M3 9h18"></path>',
    pound: '<path d="M8 11h7M7 20h10M9 20c1.7-2.2 1.8-4.7.8-7.3-.9-2.4.4-5 3.4-5 1.6 0 2.8.6 3.7 1.8"></path>',
    wrench: '<path d="M14.7 6.3a4.5 4.5 0 0 1-5.8 5.8L4.8 16.2a1.8 1.8 0 0 1-2.5-2.5l4.1-4.1a4.5 4.5 0 0 1 5.8-5.8l-2.5 2.5 2 2 3-2z"></path>',
    invoice: '<path d="M6 2h9l3 3v17l-3-1.5-3 1.5-3-1.5L6 22V2z"></path><path d="M14 2v5h4M9 10h6M9 14h6M9 18h4"></path>',
    stock: '<path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5v-9z"></path><path d="m4 7.5 8 4.5 8-4.5M12 12v9"></path>',
    alert: '<path d="M12 9v4M12 17h.01"></path><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path>',
    movements: '<path d="M7 7h11M7 12h11M7 17h11"></path><path d="m4 7 1.5 1.5L8 5.5M4 12l1.5 1.5L8 10.5M4 17l1.5 1.5L8 15.5"></path>',
  };
  return `<svg class="dashboard-icon-svg" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[name] || icons.calendar}</svg>`;
}

function setDashboardDateFilter(filter) {
  if (!['today', 'week', 'month', 'year'].includes(filter)) return;
  state.dashboardDateFilter = filter;
  renderInPlace();
}

function DashboardDateFilterControls(filters, activeKey) {
  return `
    <select class="toolbar-select dashboard-range-select" aria-label="Dashboard date range" onchange="setDashboardDateFilter(this.value)">
      ${filters.map(filter => `<option value="${filter.key}" ${activeKey === filter.key ? 'selected' : ''}>${escHtml(filter.label)}</option>`).join('')}
    </select>
  `;
}

function DashboardEmptyState({ icon = 'calendar', title = 'Nothing here yet', copy = '', buttonLabel = '', onClick = '' } = {}) {
  return `
    <div class="dashboard-empty-state">
      <div class="dashboard-empty-icon">${dashboardIcon(icon)}</div>
      <div class="dashboard-empty-title">${escHtml(title)}</div>
      ${copy ? `<div class="dashboard-empty-copy">${escHtml(copy)}</div>` : ''}
      ${buttonLabel && onClick ? `<button class="btn btn-primary btn-sm" onclick="${onClick}">${escHtml(buttonLabel)}</button>` : ''}
    </div>
  `;
}

function StatCard({ title, value, subtitle, icon, tone, onClick = '' }) {
  const actionAttrs = onClick
    ? ` role="button" tabindex="0" onclick="${onClick}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();${onClick}}"`
    : '';
  return `
    <div class="dashboard-stat-card dashboard-tone-${tone || 'blue'} ${onClick ? 'dashboard-clickable' : ''}"${actionAttrs}>
      <div class="dashboard-stat-top">
        <div>
          <div class="dashboard-stat-title">${escHtml(title)}</div>
          <div class="dashboard-stat-value">${escHtml(value)}</div>
        </div>
        <div class="dashboard-stat-icon">${dashboardIcon(icon)}</div>
      </div>
      <div class="dashboard-stat-subtitle">${escHtml(subtitle)}</div>
    </div>
  `;
}

function DashboardSummaryPanel(metrics) {
  return `
    <div class="dashboard-summary-grid">
      ${metrics.map(metric => `
        <button class="dashboard-summary-item dashboard-tone-${metric.tone || 'blue'}" onclick="${metric.onClick || ''}">
          <span class="dashboard-summary-icon">${dashboardIcon(metric.icon)}</span>
          <span class="dashboard-summary-copy">
            <span class="dashboard-summary-label">${escHtml(metric.title)}</span>
            <strong>${escHtml(metric.value)}</strong>
            <small>${escHtml(metric.subtitle)}</small>
          </span>
        </button>
      `).join('')}
    </div>
  `;
}

function RevenueChart(revenueData, { title = 'Revenue overview', emptyCopy = 'Paid invoices will appear here.', rangeLabel = 'selected period', filters = [], activeFilter = state.dashboardDateFilter } = {}) {
  const hasRevenue = revenueData.some(item => Number(item.revenue) > 0);
  const totalRevenue = revenueData.reduce((sum, item) => sum + (Number(item.revenue) || 0), 0);
  const chartHeader = `
    <div class="card-header dashboard-chart-head">
      <div class="dashboard-chart-title-stack">
        <span class="card-title">${escHtml(title)}</span>
        <span class="dashboard-active-range">${escHtml(rangeLabel)}</span>
      </div>
      <div class="dashboard-chart-actions">
        <span class="dashboard-chart-total">${formatDashboardMoneyShort(totalRevenue)}</span>
        ${filters.length ? DashboardDateFilterControls(filters, activeFilter) : ''}
      </div>
    </div>
  `;
  if (!revenueData.length || !hasRevenue) {
    return `
      <div class="card dashboard-chart-card dashboard-revenue-card">
        ${chartHeader}
        ${DashboardEmptyState({
          icon: 'pound',
          title: 'No revenue yet',
          copy: emptyCopy,
          buttonLabel: 'Create invoice',
          onClick: 'showInvoiceCreateModal()',
        })}
      </div>
    `;
  }
  const width = 720;
  const height = 260;
  const padX = 46;
  const padTop = 34;
  const padBottom = 36;
  const maxRevenue = hasRevenue ? Math.max(...revenueData.map(item => Number(item.revenue) || 0), 1) : 1;
  const points = revenueData.map((item, index) => {
    const x = padX + (index / Math.max(1, revenueData.length - 1)) * (width - padX * 2);
    const y = height - padBottom - ((Number(item.revenue) || 0) / maxRevenue) * (height - padTop - padBottom);
    return { x, y, item };
  });
  const pointString = points.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const areaString = `${padX},${height - padBottom} ${pointString} ${width - padX},${height - padBottom}`;
  const labelIndexes = [...new Set([0, Math.floor((revenueData.length - 1) / 2), revenueData.length - 1])];
  const yTicks = hasRevenue ? [0, maxRevenue / 2, maxRevenue] : [0];
  const revenuePoints = points.filter(point => Number(point.item.revenue) > 0);
  const valueLabelPoints = hasRevenue
    ? (revenuePoints.length <= 12
      ? revenuePoints
      : revenuePoints
        .slice()
        .sort((a, b) => Number(b.item.revenue) - Number(a.item.revenue))
        .slice(0, 12)
        .sort((a, b) => a.x - b.x))
    : [points[Math.floor((points.length - 1) / 2)]].filter(Boolean);
  return `
    <div class="card dashboard-chart-card dashboard-revenue-card">
      ${chartHeader}
      <svg class="dashboard-line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Revenue for ${escHtml(rangeLabel)}">
        ${yTicks.map(tick => {
          const y = height - padBottom - (tick / maxRevenue) * (height - padTop - padBottom);
          return `<g><line x1="${padX}" x2="${width - padX}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" class="chart-grid-line"></line><text x="8" y="${(y + 4).toFixed(1)}" class="chart-axis-label">${formatDashboardMoneyShort(tick)}</text></g>`;
        }).join('')}
        <polygon points="${areaString}" class="chart-area"></polygon>
        <polyline points="${pointString}" class="chart-line"></polyline>
        ${points.filter((_, index) => index % 5 === 0 || index === points.length - 1).map(point => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3.2" class="chart-dot"></circle>`).join('')}
        ${valueLabelPoints.map(point => `<text x="${point.x.toFixed(1)}" y="${Math.max(12, point.y - 9).toFixed(1)}" text-anchor="middle" class="chart-value-label">${formatDashboardMoneyShort(Number(point.item.revenue) || 0)}</text>`).join('')}
        ${labelIndexes.map(index => {
          const point = points[index];
          return `<text x="${point.x.toFixed(1)}" y="${height - 10}" text-anchor="middle" class="chart-axis-label">${escHtml(point.item.label || formatDashboardDay(point.item.date))}</text>`;
        }).join('')}
      </svg>
    </div>
  `;
}

function JobsStatusChart(jobStatusData) {
  const total = jobStatusData.reduce((sum, item) => sum + Number(item.count || 0), 0);
  if (!total) {
    return `
      <div class="card dashboard-chart-card dashboard-pipeline-card">
        <div class="card-header"><span class="card-title">Job pipeline</span></div>
        ${DashboardEmptyState({
          icon: 'invoice',
          title: 'No jobs in progress',
          copy: 'Jobs you create will appear here.',
          buttonLabel: 'Create job',
          onClick: 'showJobModal()',
        })}
      </div>
    `;
  }
  const activeCount = jobStatusData
    .filter(item => !['Completed', 'Paid', 'Cancelled'].includes(item.status))
    .reduce((sum, item) => sum + Number(item.count || 0), 0);
  const completedCount = jobStatusData
    .filter(item => ['Completed', 'Paid'].includes(item.status))
    .reduce((sum, item) => sum + Number(item.count || 0), 0);
  return `
    <div class="card dashboard-chart-card dashboard-pipeline-card">
      <div class="card-header dashboard-pipeline-head">
        <div>
          <span class="card-title">Job pipeline</span>
          <div class="dashboard-active-range">${activeCount} active · ${completedCount} completed</div>
        </div>
        <span class="badge badge-blue">${total} jobs</span>
      </div>
      <div class="dashboard-pipeline-list">
        ${jobStatusData.map(item => {
          const count = Number(item.count || 0);
          const pct = total ? Math.max(4, Math.round((count / total) * 100)) : 0;
          const color = DASHBOARD_STATUS_COLORS[item.status] || '#8E8B84';
          return `
            <button class="dashboard-pipeline-row" onclick="nav('jobs')">
              <span class="dashboard-pipeline-label">
                <span class="dashboard-legend-dot" style="background:${color}"></span>
                <span>${escHtml(item.status)}</span>
              </span>
              <span class="dashboard-pipeline-track"><span style="width:${count ? pct : 0}%;background:${color}"></span></span>
              <strong>${count}</strong>
            </button>
          `;
        }).join('')}
      </div>
      <div class="dashboard-pipeline-footer">
        <div>
          <span>Next focus</span>
          <strong>${jobStatusData.find(item => item.status === 'Waiting for Parts')?.count || 0} waiting for parts</strong>
        </div>
        <button class="btn btn-sm" onclick="nav('jobs')">View Jobs</button>
      </div>
    </div>
  `;
}

function JobsStatusDonut(jobStatusData) {
  const total = jobStatusData.reduce((sum, item) => sum + Number(item.count || 0), 0);
  if (!total) return '';
  let cursor = 0;
  const gradient = jobStatusData.map(item => {
    const start = cursor;
    const end = cursor + (Number(item.count || 0) / total) * 360;
    cursor = end;
    return `${DASHBOARD_STATUS_COLORS[item.status] || '#8E8B84'} ${start.toFixed(1)}deg ${end.toFixed(1)}deg`;
  }).join(', ');
  return `
    <div class="dashboard-donut-wrap">
      <div class="dashboard-donut" style="background: conic-gradient(${gradient});">
        <div class="dashboard-donut-centre"><strong>${total}</strong><span>Total</span></div>
      </div>
      <div class="dashboard-status-legend">
          ${jobStatusData.map(item => `
            <div class="dashboard-legend-row">
              <span class="dashboard-legend-dot" style="background:${DASHBOARD_STATUS_COLORS[item.status] || '#8E8B84'}"></span>
              <span>${escHtml(item.status)}</span>
              <strong>${item.count}</strong>
            </div>
          `).join('')}
      </div>
    </div>
  `;
}

function UpcomingBookings(bookings, { emptyCopy = 'No bookings today' } = {}) {
  const today = formatDateInputValue();
  const upcoming = bookings
    .filter(booking => getDashboardBookingStatus(booking) !== 'Cancelled')
    .filter(booking => !getDashboardBookingDate(booking) || getDashboardBookingDate(booking) >= today)
    .sort((a, b) => `${getDashboardBookingDate(a)} ${getDashboardBookingTime(a)}`.localeCompare(`${getDashboardBookingDate(b)} ${getDashboardBookingTime(b)}`))
    .slice(0, 5);
  return `
    <div class="card dashboard-table-card">
      <div class="card-header"><span class="card-title">Upcoming bookings</span><span class="badge badge-gray">${upcoming.length}</span></div>
      ${upcoming.length === 0 ? DashboardEmptyState({
        icon: 'calendar',
        title: 'No bookings this week',
        copy: emptyCopy,
        buttonLabel: 'New booking',
        onClick: 'showBookingFlow()',
      }) : `
        <div class="dashboard-table-scroll">
          <table>
            <thead><tr><th>Time</th><th>Customer</th><th>Vehicle</th><th>Service</th><th>Status</th></tr></thead>
            <tbody>
              ${upcoming.map(booking => `
                <tr>
                  <td style="font-weight:500">${escHtml(getDashboardBookingTime(booking))}</td>
                  <td>${escHtml(getDashboardBookingCustomer(booking))}</td>
                  <td>${escHtml(getDashboardBookingVehicle(booking))}</td>
                  <td>${escHtml(getDashboardBookingService(booking))}</td>
                  <td>${StatusBadge(getDashboardBookingStatus(booking))}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

function OutstandingInvoices(invoices) {
  const outstanding = invoices.filter(isDashboardOutstandingInvoice).slice(0, 5);
  return `
    <div class="card dashboard-table-card">
      <div class="card-header"><span class="card-title">Outstanding Invoices</span><span class="badge badge-amber">${outstanding.length}</span></div>
      ${outstanding.length === 0 ? '<div class="dashboard-empty-state">No unpaid invoices</div>' : `
        <div class="dashboard-table-scroll">
          <table>
            <thead><tr><th>Invoice No</th><th>Customer</th><th>Vehicle</th><th>Amount</th><th>Due Date</th><th>Status</th></tr></thead>
            <tbody>
              ${outstanding.map(invoice => `
                <tr>
                  <td style="font-weight:500">${escHtml(invoice.invoice_number || invoice.number || invoice.id || '')}</td>
                  <td>${escHtml(getDashboardInvoiceCustomer(invoice))}</td>
                  <td>${escHtml(getDashboardInvoiceVehicle(invoice))}</td>
                  <td>${fmt(getDashboardInvoiceBalance(invoice))}</td>
                  <td>${fmtDate(invoice.due_date)}</td>
                  <td>${StatusBadge(getDashboardInvoiceStatus(invoice))}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

function LowStockAlertsWidget(stockItems) {
  const lowStockItems = getLowStockItems(stockItems);
  return `
    <div class="card dashboard-table-card">
      <div class="card-header"><span class="card-title">Low Stock Alerts</span><span class="badge ${lowStockItems.length ? 'badge-amber' : 'badge-green'}">${lowStockItems.length}</span></div>
      ${lowStockItems.length === 0 ? '<div class="dashboard-empty-state">All stock levels are healthy.</div>' : `
        <div class="dashboard-table-scroll">
          <table>
            <thead><tr><th>Part Name</th><th>SKU</th><th>Current Qty</th><th>Minimum</th><th>Supplier</th><th></th></tr></thead>
            <tbody>
              ${lowStockItems.map(item => `
                <tr class="clickable" onclick="openInventory('low', ${Number(item.id) || 0})">
                  <td style="font-weight:500">${escHtml(getDashboardPartName(item))}</td>
                  <td>${escHtml(getInventorySku(item))}</td>
                  <td>${fmtQty(getInventoryQuantity(item))}</td>
                  <td>${fmtQty(getInventoryMinimumStockLevel(item))}</td>
                  <td>${escHtml(getInventorySupplier(item))}</td>
                  <td><button class="btn btn-sm btn-primary" onclick="event.stopPropagation();showInventoryMovementModal(${Number(item.id) || 0}, 'Stock In')">Order / Restock</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

function OutOfStockWarningWidget(stockItems) {
  const outOfStockItems = getOutOfStockItems(stockItems);
  return `
    <div class="card dashboard-table-card dashboard-urgent-card">
      <div class="card-header"><span class="card-title">Out of Stock</span><span class="badge ${outOfStockItems.length ? 'badge-red' : 'badge-green'}">${outOfStockItems.length}</span></div>
      ${outOfStockItems.length === 0 ? '<div class="dashboard-empty-state">No out of stock items</div>' : `
        <div class="dashboard-table-scroll">
          <table>
            <thead><tr><th>Part Name</th><th>SKU</th><th>Supplier</th></tr></thead>
            <tbody>
              ${outOfStockItems.map(item => `
                <tr class="clickable dashboard-urgent-row" onclick="openInventory('out', ${Number(item.id) || 0})">
                  <td style="font-weight:500">${escHtml(getDashboardPartName(item))}</td>
                  <td>${escHtml(getInventorySku(item))}</td>
                  <td>${escHtml(getInventorySupplier(item))}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

function RecentInventoryMovementsWidget(movements) {
  const recentMovements = getRecentInventoryMovements(movements, 5);
  return `
    <div class="card dashboard-table-card">
      <div class="card-header"><span class="card-title">Recent Stock Movements</span><span class="badge badge-gray">${recentMovements.length}</span></div>
      ${recentMovements.length === 0 ? '<div class="dashboard-empty-state">No stock movements yet</div>' : `
        <div class="dashboard-table-scroll">
          <table>
            <thead><tr><th>Part Name</th><th>Movement</th><th>Quantity</th><th>Date</th><th>Notes</th></tr></thead>
            <tbody>
              ${recentMovements.map(movement => `
                <tr class="clickable" onclick="openInventory('all', ${Number(movement.inventory_item_id) || 0})">
                  <td style="font-weight:500">${escHtml(movement.part_name || getInventoryPartName(getInventoryItemById(movement.inventory_item_id)))}</td>
                  <td>${StatusBadge(movement.movement_type || 'Adjustment')}</td>
                  <td>${escHtml(formatInventoryMovementQuantity(movement))}</td>
                  <td>${fmtDateTime(movement.movement_date || movement.date)}</td>
                  <td>${escHtml(movement.notes || '—')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

function InventoryControlWidget(stockItems) {
  const lowStockItems = getLowStockItems(stockItems);
  const outOfStockItems = getOutOfStockItems(stockItems);
  const totalValue = getTotalInventoryValue(stockItems);
  return `
    <div class="card dashboard-table-card inventory-control-card">
      <div class="card-header inventory-control-head">
        <span class="card-title">Inventory alerts</span>
        <button class="btn btn-ghost btn-sm" onclick="openInventory('all')">View all</button>
      </div>

      <div class="inventory-alert-list">
        <button class="inventory-alert-line ${lowStockItems.length ? 'is-warning' : ''}" onclick="openInventory('low')">
          <span>${dashboardIcon('alert')} Low stock</span>
          <strong>${lowStockItems.length} item${lowStockItems.length === 1 ? '' : 's'}</strong>
        </button>
        <button class="inventory-alert-line ${outOfStockItems.length ? 'is-danger' : ''}" onclick="openInventory('out')">
          <span>${dashboardIcon('alert')} Out of stock</span>
          <strong>${outOfStockItems.length} item${outOfStockItems.length === 1 ? '' : 's'}</strong>
        </button>
        <button class="inventory-alert-line" onclick="openInventory('all')">
          <span>${dashboardIcon('stock')} Total value</span>
          <strong>${fmt(totalValue)}</strong>
        </button>
      </div>
    </div>
  `;
}

function renderDashboard() {
  const data = getDashboardData();
  const range = getDashboardDateRange();
  const rangeCopy = getDashboardRangeCopy(range);
  const rangeLabel = getDashboardRangeDisplay(range);
  const todayIso = formatDateInputValue();
  const todayLabel = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const weekRange = getDashboardDateRange('week');
  const monthRange = getDashboardDateRange('month');
  const todayBookings = data.bookings.filter(booking => getDashboardBookingStatus(booking) !== 'Cancelled' && getDashboardBookingDate(booking) === todayIso);
  const weekBookings = data.bookings.filter(booking => getDashboardBookingStatus(booking) !== 'Cancelled' && isDashboardDateInRange(getDashboardBookingDate(booking), weekRange));
  const monthRevenueData = buildDashboardRevenueDataForRange(data, monthRange);
  const revenueThisMonth = monthRevenueData.reduce((sum, item) => sum + (Number(item.revenue) || 0), 0);
  const periodRevenueData = buildDashboardRevenueDataForRange(data, range);
  const jobStatusData = buildJobStatusDataFromJobs(data.jobs, data.invoices);
  const activeJobs = data.jobs.filter(job => !['Completed', 'Paid', 'Cancelled'].includes(normalizeDashboardJobStatus(job, data.invoices)));
  const waitingForPartsCount = jobStatusData.find(item => item.status === 'Waiting for Parts')?.count || 0;
  const unpaidInvoices = data.invoices.filter(isDashboardOutstandingInvoice);
  const unpaidInvoiceTotal = unpaidInvoices.reduce((sum, invoice) => sum + getDashboardInvoiceBalance(invoice), 0);
  const overdueInvoices = data.invoices.filter(invoice => getDashboardInvoiceStatus(invoice) === 'Overdue');
  const overdueInvoicesCount = overdueInvoices.length;
  const inventoryItems = data.stockItems;
  const filters = [
    { key: 'today', label: 'Today' },
    { key: 'week', label: 'This Week' },
    { key: 'month', label: 'This Month' },
    { key: 'year', label: 'This Year' },
  ];

  return `
    <div class="dashboard-shell">
      <div class="dashboard-toolbar">
        <div>
          <h1>Dashboard</h1>
          <div class="dashboard-active-range">${escHtml(todayLabel)}</div>
        </div>
        <div class="dashboard-actions">
          <button class="btn btn-primary" onclick="showBookingFlow()">+ New booking</button>
          <button class="btn btn-secondary" onclick="showJobModal()">+ New job</button>
        </div>
      </div>

      ${DashboardSummaryPanel([
        {
          title: 'Bookings today',
          value: String(todayBookings.length),
          subtitle: todayBookings.length ? `${dashboardPlural(todayBookings.length, 'booking')} scheduled` : 'No bookings today',
          icon: 'calendar',
          tone: 'blue',
          onClick: "nav('calendar')",
        },
        {
          title: 'Active jobs',
          value: String(activeJobs.length),
          subtitle: waitingForPartsCount ? `${waitingForPartsCount} waiting for parts` : 'No jobs in progress',
          icon: 'wrench',
          tone: 'blue',
          onClick: "nav('jobs')",
        },
        {
          title: 'Revenue this month',
          value: fmt(revenueThisMonth),
          subtitle: revenueThisMonth > 0 ? 'Paid invoices this month' : 'No revenue yet',
          icon: 'pound',
          tone: 'green',
          onClick: "nav('invoices')",
        },
        {
          title: 'Unpaid invoices',
          value: fmt(unpaidInvoiceTotal),
          subtitle: unpaidInvoices.length ? `${dashboardPlural(unpaidInvoices.length, 'invoice')} unpaid` : 'All invoices paid',
          icon: 'invoice',
          tone: overdueInvoicesCount ? 'red' : 'amber',
          onClick: "nav('invoices')",
        },
      ])}

      <div class="dashboard-chart-grid">
        ${RevenueChart(periodRevenueData, {
          emptyCopy: rangeCopy.revenueEmpty || 'Paid invoices will appear here.',
          rangeLabel,
          filters,
          activeFilter: range.key,
        })}
        ${JobsStatusChart(jobStatusData)}
      </div>

      <div class="dashboard-secondary-grid">
        ${UpcomingBookings(weekBookings, { emptyCopy: 'Create your first booking to start filling your calendar.' })}
        ${InventoryControlWidget(inventoryItems)}
      </div>
    </div>
  `;
}

// ── REPORTS ───────────────────────────────────────────────────────────────
const REPORT_DATE_FILTERS = Object.freeze([
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'this-week', label: 'This Week' },
  { key: 'last-week', label: 'Last Week' },
  { key: 'this-month', label: 'This Month' },
  { key: 'last-month', label: 'Last Month' },
  { key: 'this-year', label: 'This Year' },
  { key: 'custom', label: 'Custom Range' },
]);
const REPORT_SECTIONS = Object.freeze([
  { key: 'overview', label: 'Overview' },
  { key: 'workers', label: 'Workers' },
]);
const REPORT_CATEGORIES = Object.freeze(['MOT', 'Service', 'Diagnostics', 'Repair', 'Tyres', 'Brakes', 'Other']);
const REPORT_PAID_AMOUNT_FIELDS = Object.freeze(['paid_amount', 'amount_paid', 'paid_total', 'total_paid', 'payment_amount', 'payments_total']);
const REPORT_PAYMENT_DATE_FIELDS = Object.freeze(['payment_date', 'paid_at', 'date_paid', 'paid_date', 'last_payment_date']);

function normalizeReportsSection(section) {
  const key = String(section || '').trim().toLowerCase();
  return REPORT_SECTIONS.some(item => item.key === key) ? key : 'overview';
}

function normalizeReportsDateFilter(filter) {
  const key = String(filter || '').trim().toLowerCase();
  return REPORT_DATE_FILTERS.some(item => item.key === key) ? key : 'this-month';
}

function parseReportDate(value) {
  const text = normalizeDashboardDateText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function makeReportsDateRange(key, start, end) {
  const normalizedStart = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const normalizedEnd = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  const range = {
    key,
    start: normalizedStart,
    end: normalizedEnd,
    startIso: formatDateInputValue(normalizedStart),
    endIso: formatDateInputValue(normalizedEnd),
  };
  range.label = getReportsDateRangeLabel(range);
  range.breakdownMode = getReportsBreakdownMode(range);
  return range;
}

function getReportsDateRange(filter = state.reportsDateFilter) {
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const key = normalizeReportsDateFilter(filter);
  let start = todayStart;
  let end = todayStart;

  if (key === 'yesterday') {
    start = addDashboardDays(todayStart, -1);
    end = start;
  } else if (key === 'this-week') {
    start = startOfDashboardWeek(todayStart);
    end = addDashboardDays(start, 6);
  } else if (key === 'last-week') {
    start = startOfDashboardWeek(addDashboardDays(todayStart, -7));
    end = addDashboardDays(start, 6);
  } else if (key === 'last-month') {
    start = new Date(todayStart.getFullYear(), todayStart.getMonth() - 1, 1);
    end = new Date(todayStart.getFullYear(), todayStart.getMonth(), 0);
  } else if (key === 'this-year') {
    start = new Date(todayStart.getFullYear(), 0, 1);
    end = new Date(todayStart.getFullYear(), 11, 31);
  } else if (key === 'custom') {
    const fallbackStart = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1);
    const fallbackEnd = todayStart;
    start = parseReportDate(state.reportsCustomFrom) || fallbackStart;
    end = parseReportDate(state.reportsCustomTo) || fallbackEnd;
    if (start > end) {
      const swap = start;
      start = end;
      end = swap;
    }
  } else if (key === 'this-month') {
    start = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1);
    end = new Date(todayStart.getFullYear(), todayStart.getMonth() + 1, 0);
  }

  return makeReportsDateRange(key, start, end);
}

function getReportsDateRangeLabel(range) {
  if (range.startIso === range.endIso) return fmtDate(range.startIso);
  return `${fmtDate(range.startIso)} to ${fmtDate(range.endIso)}`;
}

function getReportsBreakdownMode(range) {
  if (range.key === 'this-year') return 'month';
  if (range.key === 'this-month' || range.key === 'last-month') return 'week';
  if (range.key !== 'custom') return 'day';
  const days = Math.max(1, Math.round((range.end - range.start) / 86400000) + 1);
  if (days <= 14) return 'day';
  if (days <= 120) return 'week';
  return 'month';
}

function setReportsDateFilter(filter) {
  const key = normalizeReportsDateFilter(filter);
  state.reportsDateFilter = key;
  if (key === 'custom' && !state.reportsCustomFrom && !state.reportsCustomTo) {
    const fallback = getReportsDateRange('this-month');
    state.reportsCustomFrom = fallback.startIso;
    state.reportsCustomTo = fallback.endIso;
  }
  renderInPlace();
}

function setReportsSection(section) {
  state.reportsSection = normalizeReportsSection(section);
  renderInPlace();
}

function updateReportsCustomDate(field, value) {
  const dateValue = /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : '';
  if (field === 'from') state.reportsCustomFrom = dateValue;
  if (field === 'to') state.reportsCustomTo = dateValue;
  state.reportsDateFilter = 'custom';
  renderInPlace();
}

function isReportDateInRange(dateText, range) {
  const normalized = normalizeDashboardDateText(dateText);
  return Boolean(normalized && normalized >= range.startIso && normalized <= range.endIso);
}

function getReportInvoiceDate(invoice) {
  return invoice?.date_issued || invoice?.invoice_date || invoice?.date || '';
}

function getReportPaymentDate(invoice) {
  for (const field of REPORT_PAYMENT_DATE_FIELDS) {
    const value = normalizeDashboardDateText(invoice?.[field]);
    if (value) return value;
  }
  const payments = Array.isArray(invoice?.payments) ? invoice.payments : [];
  const datedPayment = payments
    .map(payment => normalizeDashboardDateText(payment?.payment_date || payment?.paid_at || payment?.date))
    .filter(Boolean)
    .sort()
    .pop();
  return datedPayment || '';
}

function getReportInvoiceTotal(invoice) {
  return Math.max(0, Number(invoice?.total ?? invoice?.amount ?? invoice?.subtotal ?? 0) || 0);
}

function getReportExplicitPaidAmount(invoice) {
  for (const field of REPORT_PAID_AMOUNT_FIELDS) {
    const value = Number(invoice?.[field]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  const payments = Array.isArray(invoice?.payments) ? invoice.payments : [];
  if (payments.length) {
    const total = payments.reduce((sum, payment) => {
      const amount = Number(payment?.amount ?? payment?.paid_amount ?? payment?.total ?? 0);
      return sum + (Number.isFinite(amount) ? amount : 0);
    }, 0);
    if (total > 0) return total;
  }
  return null;
}

function getReportPaidAmount(invoice) {
  const total = getReportInvoiceTotal(invoice);
  const rawStatus = String(invoice?.status || '').trim().toLowerCase();
  if (rawStatus === 'paid') return total;
  const explicit = getReportExplicitPaidAmount(invoice);
  if (explicit !== null) return Math.min(total, explicit);
  return 0;
}

function getReportRemainingBalance(invoice) {
  return Math.max(0, getReportInvoiceTotal(invoice) - getReportPaidAmount(invoice));
}

function isReportInvoiceOverdue(invoice) {
  const dueDate = normalizeDashboardDateText(invoice?.due_date);
  return Boolean(dueDate && dueDate < formatDateInputValue() && getReportRemainingBalance(invoice) > 0);
}

function getReportPaymentStatus(invoice) {
  const rawStatus = String(invoice?.status || '').trim().toLowerCase();
  if (getReportRemainingBalance(invoice) <= 0 || rawStatus === 'paid') return 'Paid';
  if (rawStatus === 'partial' || rawStatus === 'part paid' || getReportPaidAmount(invoice) > 0) return 'Part paid';
  if (isReportInvoiceOverdue(invoice)) return 'Overdue';
  return 'Unpaid';
}

function getReportStatusTone(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'paid' || normalized === 'completed') return 'green';
  if (normalized === 'part paid' || normalized === 'partial' || normalized.includes('waiting')) return 'amber';
  if (normalized === 'overdue' || normalized === 'unpaid' || normalized === 'cancelled') return 'red';
  return 'blue';
}

function getReportJobForInvoice(invoice) {
  return state.jobs.find(job => String(job.id) === String(invoice?.job_id || '')) || null;
}

function getReportVehicleForJob(job) {
  return state.vehicles.find(vehicle => String(vehicle.id) === String(job?.vehicle_id || '')) || null;
}

function getReportClientForJob(job) {
  return state.clients.find(client => String(client.id) === String(job?.client_id || '')) || null;
}

function getReportInvoiceCustomerName(invoice, job = getReportJobForInvoice(invoice)) {
  const client = getReportClientForJob(job);
  return invoice?.client_name || job?.client_name || client?.name || 'Customer';
}

function getReportInvoiceRegistration(invoice, job = getReportJobForInvoice(invoice)) {
  const vehicle = getReportVehicleForJob(job);
  return invoice?.registration || job?.registration || vehicle?.registration || '';
}

function getReportJobCategory(job, invoice = null) {
  const text = [
    job?.booking_reason,
    job?.complaint,
    job?.findings,
    job?.work_performed,
    job?.customer_notes,
    invoice?.notes,
  ].filter(Boolean).join(' ').toLowerCase();
  if (/\bmot\b/.test(text)) return 'MOT';
  if (/service|oil|filter|interim|full service/.test(text)) return 'Service';
  if (/diagnostic|diagnose|fault|inspection|check|scan/.test(text)) return 'Diagnostics';
  if (/tyre|tire|wheel|puncture|alignment|tracking/.test(text)) return 'Tyres';
  if (/brake|pads?|discs?|caliper/.test(text)) return 'Brakes';
  if (/repair|fix|replace|clutch|exhaust|suspension|cambelt|timing|battery|engine|gearbox|starter|alternator/.test(text)) return 'Repair';
  return 'Other';
}

function buildReportInvoiceRow(invoice) {
  const job = getReportJobForInvoice(invoice);
  const total = getReportInvoiceTotal(invoice);
  const paid = getReportPaidAmount(invoice);
  const remaining = Math.max(0, total - paid);
  const paymentStatus = getReportPaymentStatus(invoice);
  return {
    invoice,
    job,
    invoiceNumber: invoice?.invoice_number || `Invoice ${invoice?.id || ''}`.trim(),
    customerName: getReportInvoiceCustomerName(invoice, job),
    registration: getReportInvoiceRegistration(invoice, job),
    category: getReportJobCategory(job, invoice),
    jobStatus: job?.status || 'Not linked',
    invoiceStatus: paymentStatus,
    total,
    paid,
    remaining,
    invoiceDate: getReportInvoiceDate(invoice),
    dueDate: invoice?.due_date || '',
    paymentDate: getReportPaymentDate(invoice),
    overdue: isReportInvoiceOverdue(invoice),
  };
}

function getReportsBucketLabel(startIso, endIso, mode) {
  if (mode === 'month') {
    const date = parseReportDate(startIso);
    return date ? date.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : startIso;
  }
  if (mode === 'week') {
    if (startIso === endIso) return fmtDate(startIso);
    const start = parseReportDate(startIso);
    const end = parseReportDate(endIso);
    if (!start || !end) return `${startIso} to ${endIso}`;
    const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
    const startLabel = start.toLocaleDateString('en-GB', sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' });
    const endLabel = end.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return `${startLabel}-${endLabel}`;
  }
  return formatDashboardDay(startIso);
}

function buildReportsRevenueBuckets(range) {
  const mode = range.breakdownMode;
  const buckets = [];
  if (mode === 'month') {
    for (let cursor = new Date(range.start.getFullYear(), range.start.getMonth(), 1); cursor <= range.end; cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)) {
      const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
      const start = cursor < range.start ? range.start : cursor;
      const end = monthEnd > range.end ? range.end : monthEnd;
      buckets.push({ key: formatDateInputValue(cursor).slice(0, 7), startIso: formatDateInputValue(start), endIso: formatDateInputValue(end), label: getReportsBucketLabel(formatDateInputValue(start), formatDateInputValue(end), mode), revenue: 0, paid: 0, invoiceCount: 0 });
    }
    return buckets;
  }
  if (mode === 'week') {
    for (let cursor = startOfDashboardWeek(range.start); cursor <= range.end; cursor = addDashboardDays(cursor, 7)) {
      const weekEnd = addDashboardDays(cursor, 6);
      const start = cursor < range.start ? range.start : cursor;
      const end = weekEnd > range.end ? range.end : weekEnd;
      buckets.push({ key: formatDateInputValue(cursor), startIso: formatDateInputValue(start), endIso: formatDateInputValue(end), label: getReportsBucketLabel(formatDateInputValue(start), formatDateInputValue(end), mode), revenue: 0, paid: 0, invoiceCount: 0 });
    }
    return buckets;
  }
  for (let cursor = new Date(range.start); cursor <= range.end; cursor = addDashboardDays(cursor, 1)) {
    const iso = formatDateInputValue(cursor);
    buckets.push({ key: iso, startIso: iso, endIso: iso, label: getReportsBucketLabel(iso, iso, mode), revenue: 0, paid: 0, invoiceCount: 0 });
  }
  return buckets;
}

function buildReportsRevenueBreakdown(range, invoiceRows) {
  const buckets = buildReportsRevenueBuckets(range);
  const bucketMap = new Map(buckets.map(bucket => [bucket.key, bucket]));
  invoiceRows.forEach(row => {
    const dateText = normalizeDashboardDateText(row.invoiceDate);
    if (!dateText) return;
    let bucketKey = dateText;
    if (range.breakdownMode === 'month') bucketKey = dateText.slice(0, 7);
    if (range.breakdownMode === 'week') bucketKey = formatDateInputValue(startOfDashboardWeek(parseReportDate(dateText)));
    const bucket = bucketMap.get(bucketKey);
    if (!bucket) return;
    bucket.revenue += row.total;
    bucket.paid += row.paid;
    bucket.invoiceCount += 1;
  });
  return buckets;
}

function buildReportsCategoryBreakdown(invoiceRows, periodJobs) {
  const map = new Map(REPORT_CATEGORIES.map(category => [category, { category, revenue: 0, jobKeys: new Set() }]));
  const invoicedJobIds = new Set();
  invoiceRows.forEach(row => {
    const category = REPORT_CATEGORIES.includes(row.category) ? row.category : 'Other';
    const entry = map.get(category);
    entry.revenue += row.total;
    const key = row.job?.id ? `job-${row.job.id}` : `invoice-${row.invoice?.id || row.invoiceNumber}`;
    entry.jobKeys.add(key);
    if (row.job?.id) invoicedJobIds.add(String(row.job.id));
  });
  periodJobs.forEach(job => {
    if (invoicedJobIds.has(String(job.id))) return;
    const category = getReportJobCategory(job);
    const entry = map.get(category) || map.get('Other');
    entry.jobKeys.add(`job-${job.id}`);
  });
  const totalRevenue = Array.from(map.values()).reduce((sum, entry) => sum + entry.revenue, 0);
  return Array.from(map.values())
    .map(entry => ({
      category: entry.category,
      revenue: Math.round(entry.revenue * 100) / 100,
      jobs: entry.jobKeys.size,
      percent: totalRevenue ? Math.round((entry.revenue / totalRevenue) * 1000) / 10 : 0,
    }))
    .filter(entry => entry.revenue > 0 || entry.jobs > 0)
    .sort((a, b) => (b.revenue - a.revenue) || (b.jobs - a.jobs) || a.category.localeCompare(b.category));
}

function normalizeReportCustomerName(name) {
  return String(name || 'Customer').trim() || 'Customer';
}

function getReportCustomerKeyFromJob(job) {
  if (job?.client_id) return `id:${job.client_id}`;
  return `name:${normalizeReportCustomerName(job?.client_name).toLowerCase()}`;
}

function getReportCustomerKeyFromBooking(booking) {
  if (booking?.client_id) return `id:${booking.client_id}`;
  return `name:${normalizeReportCustomerName(booking?.client_name).toLowerCase()}`;
}

function getReportCustomerKeyFromInvoiceRow(row) {
  if (row.job?.client_id) return `id:${row.job.client_id}`;
  return `name:${normalizeReportCustomerName(row.customerName).toLowerCase()}`;
}

function getReportCustomerNameForKey(key, fallback = 'Customer') {
  if (String(key).startsWith('id:')) {
    const id = String(key).slice(3);
    const client = state.clients.find(item => String(item.id) === id);
    if (client?.name) return client.name;
  }
  return normalizeReportCustomerName(fallback);
}

function buildReportsCustomerReport(range, invoiceRows, periodJobs, periodBookings) {
  const allInvoiceRows = (Array.isArray(state.invoices) ? state.invoices : []).map(buildReportInvoiceRow);
  const activity = new Map();
  const addActivity = (key, name, dateText) => {
    const date = normalizeDashboardDateText(dateText);
    if (!key || !date) return;
    if (!activity.has(key)) activity.set(key, { key, name: getReportCustomerNameForKey(key, name), dates: [] });
    const entry = activity.get(key);
    entry.name = getReportCustomerNameForKey(key, entry.name || name);
    entry.dates.push(date);
  };
  (state.jobs || []).forEach(job => addActivity(getReportCustomerKeyFromJob(job), job.client_name, getDashboardJobDate(job)));
  (state.bookings || []).forEach(booking => addActivity(getReportCustomerKeyFromBooking(booking), booking.client_name, getDashboardBookingDate(booking)));
  allInvoiceRows.forEach(row => addActivity(getReportCustomerKeyFromInvoiceRow(row), row.customerName, row.invoiceDate));

  const periodKeys = new Set();
  periodJobs.forEach(job => periodKeys.add(getReportCustomerKeyFromJob(job)));
  periodBookings.forEach(booking => periodKeys.add(getReportCustomerKeyFromBooking(booking)));
  invoiceRows.forEach(row => periodKeys.add(getReportCustomerKeyFromInvoiceRow(row)));

  const customers = Array.from(activity.values()).map(entry => {
    const dates = entry.dates.filter(Boolean).sort();
    return {
      ...entry,
      dates,
      firstDate: dates[0] || '',
      hasPeriodActivity: periodKeys.has(entry.key),
      hasPreviousActivity: dates.some(date => date < range.startIso),
    };
  });

  const spendMap = new Map();
  invoiceRows.forEach(row => {
    const key = getReportCustomerKeyFromInvoiceRow(row);
    if (!spendMap.has(key)) spendMap.set(key, { key, name: row.customerName, spend: 0, unpaid: 0, invoices: 0 });
    const entry = spendMap.get(key);
    entry.spend += row.total;
    entry.unpaid += row.remaining;
    entry.invoices += 1;
  });

  return {
    topCustomers: Array.from(spendMap.values()).sort((a, b) => b.spend - a.spend).slice(0, 6),
    newCustomers: customers.filter(customer => customer.firstDate && isReportDateInRange(customer.firstDate, range)).sort((a, b) => a.firstDate.localeCompare(b.firstDate)).slice(0, 8),
    returningCustomers: customers.filter(customer => customer.hasPeriodActivity && customer.hasPreviousActivity).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 8),
    unpaidCustomers: Array.from(spendMap.values()).filter(customer => customer.unpaid > 0).sort((a, b) => b.unpaid - a.unpaid).slice(0, 6),
  };
}

function buildReportsPayments(invoiceRows) {
  const paidRows = invoiceRows.filter(row => row.invoiceStatus === 'Paid');
  const partPaidRows = invoiceRows.filter(row => row.invoiceStatus === 'Part paid');
  const overdueRows = invoiceRows.filter(row => row.overdue);
  const unpaidRows = invoiceRows.filter(row => row.remaining > 0 && row.invoiceStatus !== 'Part paid');
  const amount = rows => rows.reduce((sum, row) => sum + (row.invoiceStatus === 'Paid' ? row.total : row.remaining), 0);
  return {
    paid: { count: paidRows.length, amount: paidRows.reduce((sum, row) => sum + row.paid, 0) },
    unpaid: { count: unpaidRows.length, amount: amount(unpaidRows) },
    partPaid: { count: partPaidRows.length, amount: partPaidRows.reduce((sum, row) => sum + row.remaining, 0) },
    overdue: { count: overdueRows.length, amount: overdueRows.reduce((sum, row) => sum + row.remaining, 0) },
    tableRows: invoiceRows.slice().sort((a, b) => String(a.dueDate || '').localeCompare(String(b.dueDate || ''))),
  };
}

function buildReportsJobsReport(periodJobs, invoiceRows, categoryBreakdown) {
  const invoiceByJobId = new Map(invoiceRows.filter(row => row.job?.id).map(row => [String(row.job.id), row]));
  const completed = periodJobs.filter(job => String(job.status || '').trim() === 'Completed');
  const cancelled = periodJobs.filter(job => String(job.status || '').trim() === 'Cancelled');
  const open = periodJobs.filter(job => !['Completed', 'Cancelled'].includes(String(job.status || '').trim()));
  const jobValues = periodJobs.map(job => (invoiceByJobId.get(String(job.id))?.total ?? Number(job.subtotal || 0)) || 0);
  const categoryCounts = new Map();
  periodJobs.forEach(job => {
    const category = getReportJobCategory(job);
    categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
  });
  const mostCommonCategories = Array.from(categoryCounts.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
  return {
    completed: completed.length,
    cancelled: cancelled.length,
    open: open.length,
    averageJobValue: jobValues.length ? jobValues.reduce((sum, value) => sum + value, 0) / jobValues.length : 0,
    mostCommonCategories: mostCommonCategories.length ? mostCommonCategories : categoryBreakdown.map(item => ({ category: item.category, count: item.jobs })),
    jobs: periodJobs.map(job => {
      const invoiceRow = invoiceByJobId.get(String(job.id));
      return {
        id: job.id,
        customer: job.client_name || 'Customer',
        registration: job.registration || '',
        category: getReportJobCategory(job),
        status: job.status || 'New',
        value: (invoiceRow?.total ?? Number(job.subtotal || 0)) || 0,
        opened: getDashboardJobDate(job),
      };
    }),
  };
}

function getWorkerReportDate(row) {
  return normalizeDashboardDateText(getReportPaymentDate(row.invoice)) || normalizeDashboardDateText(row.invoiceDate);
}

function makeWorkerAggregationRow(worker = null) {
  return {
    key: worker ? String(worker.id) : 'unassigned',
    workerId: worker ? normalizeWorkerId(worker.id) : null,
    worker,
    name: worker ? getWorkerDisplayName(worker) : 'Unassigned labour',
    role: worker?.position || '-',
    rate: worker ? normalizeWorkerPercent(worker.commission_percent, 0) : 0,
    labour: 0,
    payout: 0,
    lines: 0,
    invoiceKeys: new Set(),
  };
}

function buildWorkersReportData(range) {
  const workers = (state.workers || [])
    .map(worker => ({
      ...worker,
      id: normalizeWorkerId(worker.id),
      commission_percent: normalizeWorkerPercent(worker.commission_percent, 30),
      active: worker.active !== false,
    }))
    .filter(worker => worker.id)
    .sort((a, b) => getWorkerDisplayName(a).localeCompare(getWorkerDisplayName(b)));
  const workerMap = new Map(workers.map(worker => [String(worker.id), worker]));
  const workerRowsMap = new Map(workers.map(worker => [String(worker.id), makeWorkerAggregationRow(worker)]));
  const dayMap = new Map();
  const assignmentRows = [];
  const paidInvoiceRows = (state.invoices || [])
    .map(buildReportInvoiceRow)
    .filter(row => row.invoiceStatus === 'Paid')
    .filter(row => isReportDateInRange(getWorkerReportDate(row), range));

  paidInvoiceRows.forEach(row => {
    const paymentDate = getWorkerReportDate(row) || normalizeDashboardDateText(row.invoiceDate);
    const invoiceKey = String(row.invoice?.id || row.invoiceNumber || '');
    const jobId = row.job?.id || row.invoice?.job_id || null;
    const lines = getAllJobLinesForJob(jobId).filter(isLabourLine);
    lines.forEach(line => {
      const labour = getLineTotal(line);
      if (labour <= 0) return;
      const workerId = normalizeWorkerId(line.worker_id);
      const worker = workerId ? workerMap.get(String(workerId)) : null;
      const key = worker ? String(worker.id) : 'unassigned';
      if (!workerRowsMap.has(key)) workerRowsMap.set(key, makeWorkerAggregationRow(worker));
      const workerRow = workerRowsMap.get(key);
      const rate = workerRow.rate;
      const payout = worker ? roundMoney(labour * rate / 100) : 0;
      workerRow.labour = roundMoney(workerRow.labour + labour);
      workerRow.payout = roundMoney(workerRow.payout + payout);
      workerRow.lines += 1;
      if (invoiceKey) workerRow.invoiceKeys.add(invoiceKey);

      if (paymentDate) {
        if (!dayMap.has(paymentDate)) {
          dayMap.set(paymentDate, { date: paymentDate, label: formatDashboardDay(paymentDate), labour: 0, payout: 0, lines: 0, invoiceKeys: new Set() });
        }
        const day = dayMap.get(paymentDate);
        day.labour = roundMoney(day.labour + labour);
        day.payout = roundMoney(day.payout + payout);
        day.lines += 1;
        if (invoiceKey) day.invoiceKeys.add(invoiceKey);
      }

      assignmentRows.push({
        paymentDate,
        invoiceNumber: row.invoiceNumber,
        jobId,
        customerName: row.customerName,
        registration: row.registration,
        workerId: worker ? worker.id : null,
        workerName: worker ? getWorkerDisplayName(worker) : 'Unassigned labour',
        workerRole: worker?.position || '-',
        description: line.description || 'Labour',
        labour,
        rate,
        payout,
      });
    });
  });

  const workerRows = Array.from(workerRowsMap.values())
    .map(row => ({
      ...row,
      invoices: row.invoiceKeys.size,
    }))
    .sort((a, b) => b.payout - a.payout || b.labour - a.labour || a.name.localeCompare(b.name));
  const dailyRows = Array.from(dayMap.values())
    .map(row => ({ ...row, invoices: row.invoiceKeys.size }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const totalLabour = assignmentRows.reduce((sum, row) => sum + row.labour, 0);
  const totalPayout = assignmentRows.reduce((sum, row) => sum + row.payout, 0);

  return {
    workers,
    workerRows,
    dailyRows,
    assignmentRows: assignmentRows.sort((a, b) => String(b.paymentDate || '').localeCompare(String(a.paymentDate || '')) || a.workerName.localeCompare(b.workerName)),
    summary: {
      activeWorkers: workers.filter(worker => worker.active).length,
      paidInvoices: paidInvoiceRows.length,
      totalLabour: roundMoney(totalLabour),
      totalPayout: roundMoney(totalPayout),
      assignedLines: assignmentRows.length,
    },
  };
}

function buildReportsData() {
  const range = getReportsDateRange();
  const invoices = Array.isArray(state.invoices) ? state.invoices : [];
  const jobs = Array.isArray(state.jobs) ? state.jobs : [];
  const bookings = Array.isArray(state.bookings) ? state.bookings : [];
  const periodInvoices = invoices.filter(invoice => isReportDateInRange(getReportInvoiceDate(invoice), range)).map(buildReportInvoiceRow);
  const periodJobs = jobs.filter(job => isReportDateInRange(getDashboardJobDate(job), range));
  const periodBookings = bookings.filter(booking => isReportDateInRange(getDashboardBookingDate(booking), range));
  const totalRevenue = periodInvoices.reduce((sum, row) => sum + row.total, 0);
  const paidRevenue = periodInvoices.reduce((sum, row) => sum + row.paid, 0);
  const unpaidRevenue = periodInvoices.reduce((sum, row) => sum + row.remaining, 0);
  const overdueAmount = periodInvoices.filter(row => row.overdue).reduce((sum, row) => sum + row.remaining, 0);
  const completedJobs = periodJobs.filter(job => String(job.status || '').trim() === 'Completed').length;
  const averageJobValue = periodInvoices.length
    ? totalRevenue / periodInvoices.length
    : (periodJobs.length ? periodJobs.reduce((sum, job) => sum + (Number(job.subtotal || 0) || 0), 0) / periodJobs.length : 0);
  const revenueBreakdown = buildReportsRevenueBreakdown(range, periodInvoices);
  const categoryBreakdown = buildReportsCategoryBreakdown(periodInvoices, periodJobs);
  const customerReport = buildReportsCustomerReport(range, periodInvoices, periodJobs, periodBookings);
  const jobsReport = buildReportsJobsReport(periodJobs, periodInvoices, categoryBreakdown);
  const payments = buildReportsPayments(periodInvoices);
  const workersReport = buildWorkersReportData(range);
  return {
    range,
    periodInvoices,
    periodJobs,
    periodBookings,
    revenueBreakdown,
    categoryBreakdown,
    customerReport,
    jobsReport,
    payments,
    workersReport,
    summary: {
      totalRevenue,
      paidRevenue,
      unpaidRevenue,
      overdueAmount,
      completedJobs,
      totalBookings: periodBookings.length,
      averageJobValue,
      newCustomers: customerReport.newCustomers.length,
    },
    hasAnyData: Boolean(periodInvoices.length || periodJobs.length || periodBookings.length || customerReport.newCustomers.length),
  };
}

function renderReportsFilterControls(report) {
  const activeKey = normalizeReportsDateFilter(state.reportsDateFilter);
  const customRange = getReportsDateRange('custom');
  const customFrom = state.reportsCustomFrom || customRange.startIso;
  const customTo = state.reportsCustomTo || customRange.endIso;
  return `
    <div class="card reports-filter-card">
      <div class="reports-filter-buttons" role="group" aria-label="Reports date range">
        ${REPORT_DATE_FILTERS.map(filter => `<button class="dashboard-filter-btn ${activeKey === filter.key ? 'active' : ''}" aria-pressed="${activeKey === filter.key ? 'true' : 'false'}" onclick="setReportsDateFilter('${filter.key}')">${escHtml(filter.label)}</button>`).join('')}
      </div>
      <div class="reports-custom-range">
        <label>From <input type="date" value="${escHtml(customFrom)}" onchange="updateReportsCustomDate('from', this.value)" /></label>
        <label>To <input type="date" value="${escHtml(customTo)}" onchange="updateReportsCustomDate('to', this.value)" /></label>
        <span>${escHtml(report.range.label)}</span>
      </div>
    </div>
  `;
}

function ReportKpi({ label, value, sub, tone = 'blue' }) {
  return `
    <div class="report-kpi report-tone-${tone}">
      <span>${escHtml(label)}</span>
      <strong>${escHtml(value)}</strong>
      ${sub ? `<small>${escHtml(sub)}</small>` : ''}
    </div>
  `;
}

function renderReportSummaryCards(summary) {
  return `
    <div class="reports-summary-grid">
      ${ReportKpi({ label: 'Total Revenue', value: fmt(summary.totalRevenue), tone: 'blue' })}
      ${ReportKpi({ label: 'Paid Revenue', value: fmt(summary.paidRevenue), tone: 'green' })}
      ${ReportKpi({ label: 'Unpaid Revenue', value: fmt(summary.unpaidRevenue), tone: 'amber' })}
      ${ReportKpi({ label: 'Overdue Amount', value: fmt(summary.overdueAmount), tone: summary.overdueAmount ? 'red' : 'green' })}
      ${ReportKpi({ label: 'Jobs Completed', value: String(summary.completedJobs), tone: 'green' })}
      ${ReportKpi({ label: 'Total Bookings', value: String(summary.totalBookings), tone: 'blue' })}
      ${ReportKpi({ label: 'Average Job Value', value: fmt(summary.averageJobValue), tone: 'blue' })}
      ${ReportKpi({ label: 'New Customers', value: String(summary.newCustomers), tone: 'green' })}
    </div>
  `;
}

function renderReportRevenueBreakdown(report) {
  const modeLabel = report.range.breakdownMode === 'month' ? 'month' : report.range.breakdownMode === 'week' ? 'week' : 'day';
  const maxRevenue = Math.max(1, ...report.revenueBreakdown.map(bucket => bucket.revenue));
  const hasRevenue = report.revenueBreakdown.some(bucket => bucket.revenue > 0);
  return `
    <div class="card reports-panel">
      <div class="card-header">
        <div>
          <span class="card-title">Revenue Breakdown</span>
          <div class="dashboard-active-range">By ${modeLabel} - ${escHtml(report.range.label)}</div>
        </div>
        <span class="badge badge-green">${fmt(report.summary.totalRevenue)}</span>
      </div>
      ${hasRevenue ? `
        <div class="report-bar-list">
          ${report.revenueBreakdown.map(bucket => {
            const width = Math.max(3, Math.round((bucket.revenue / maxRevenue) * 100));
            return `
              <div class="report-bar-row">
                <div class="report-bar-label"><strong>${escHtml(bucket.label)}</strong><span>${bucket.invoiceCount} invoice${bucket.invoiceCount === 1 ? '' : 's'}</span></div>
                <div class="report-bar-track"><span style="width:${width}%"></span></div>
                <div class="report-bar-value"><strong>${fmt(bucket.revenue)}</strong><span>Paid ${fmt(bucket.paid)}</span></div>
              </div>
            `;
          }).join('')}
        </div>
      ` : '<div class="dashboard-empty-state">No revenue recorded for this period.</div>'}
    </div>
  `;
}

function renderReportCategoryBreakdown(report) {
  const maxRevenue = Math.max(1, ...report.categoryBreakdown.map(item => item.revenue));
  return `
    <div class="card reports-panel">
      <div class="card-header">
        <div>
          <span class="card-title">Category Breakdown</span>
        </div>
      </div>
      ${report.categoryBreakdown.length ? `
        <div class="table-scroll">
          <table class="data-table report-category-table">
            <thead><tr><th>Category</th><th>Total revenue</th><th>Jobs</th><th>Share</th></tr></thead>
            <tbody>
              ${report.categoryBreakdown.map(item => `
                <tr>
                  <td><strong>${escHtml(item.category)}</strong><div class="report-mini-track"><span style="width:${Math.max(3, Math.round((item.revenue / maxRevenue) * 100))}%"></span></div></td>
                  <td>${fmt(item.revenue)}</td>
                  <td>${item.jobs}</td>
                  <td>${fmtPercent(item.percent)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : '<div class="dashboard-empty-state">No category data available for this period.</div>'}
    </div>
  `;
}

function renderReportPaymentSummary(payments) {
  const chips = [
    { label: 'Paid invoices', data: payments.paid, tone: 'green' },
    { label: 'Unpaid invoices', data: payments.unpaid, tone: 'amber' },
    { label: 'Part paid invoices', data: payments.partPaid, tone: 'blue' },
    { label: 'Overdue invoices', data: payments.overdue, tone: payments.overdue.count ? 'red' : 'green' },
  ];
  return `<div class="reports-chip-grid">${chips.map(chip => `
    <div class="report-chip report-tone-${chip.tone}">
      <span>${escHtml(chip.label)}</span>
      <strong>${chip.data.count}</strong>
      <small>${fmt(chip.data.amount)}</small>
    </div>
  `).join('')}</div>`;
}

function renderReportPayments(report) {
  return `
    <div class="card reports-panel">
      <div class="card-header"><span class="card-title">Payments Report</span></div>
      ${renderReportPaymentSummary(report.payments)}
      <div class="table-scroll reports-table-gap">
        <table class="data-table reports-payment-table">
          <thead><tr><th>Invoice number</th><th>Customer</th><th>Vehicle</th><th>Amount</th><th>Paid</th><th>Remaining</th><th>Due date</th><th>Payment status</th></tr></thead>
          <tbody>
            ${report.payments.tableRows.length === 0 ? renderEmptyTableRow(8, 'No invoices in this period') : ''}
            ${report.payments.tableRows.map(row => `
              <tr>
                <td><strong>${escHtml(row.invoiceNumber)}</strong></td>
                <td>${escHtml(row.customerName)}</td>
                <td>${escHtml(row.registration || '-')}</td>
                <td>${fmt(row.total)}</td>
                <td>${fmt(row.paid)}</td>
                <td class="${row.remaining > 0 ? 'text-red' : 'text-green'}">${fmt(row.remaining)}</td>
                <td>${fmtDate(row.dueDate)}</td>
                <td>${renderPill(row.invoiceStatus, getReportStatusTone(row.invoiceStatus))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderReportCustomerList(title, customers, valueKey = '') {
  return `
    <div class="report-list-block">
      <div class="report-list-title">${escHtml(title)}</div>
      ${customers.length ? customers.map(customer => `
        <div class="report-list-row">
          <span>${escHtml(customer.name)}</span>
          <strong>${valueKey ? fmt(customer[valueKey] || 0) : fmtDate(customer.firstDate)}</strong>
        </div>
      `).join('') : '<div class="report-empty-mini">None for this period</div>'}
    </div>
  `;
}

function renderReportCustomers(report) {
  const customerReport = report.customerReport;
  return `
    <div class="reports-two-grid">
      <div class="card reports-panel">
        <div class="card-header"><span class="card-title">Customer Report</span></div>
        ${renderReportCustomerList('Top customers by spend', customerReport.topCustomers, 'spend')}
        ${renderReportCustomerList('Customers with unpaid invoices', customerReport.unpaidCustomers, 'unpaid')}
      </div>
      <div class="card reports-panel">
        <div class="card-header"><span class="card-title">Customer Activity</span></div>
        <div class="reports-chip-grid reports-chip-grid-compact">
          ${ReportKpi({ label: 'New customers', value: String(customerReport.newCustomers.length), tone: 'green' })}
          ${ReportKpi({ label: 'Returning customers', value: String(customerReport.returningCustomers.length), tone: 'blue' })}
          ${ReportKpi({ label: 'Unpaid customers', value: String(customerReport.unpaidCustomers.length), tone: customerReport.unpaidCustomers.length ? 'amber' : 'green' })}
        </div>
        ${renderReportCustomerList('New customers in selected period', customerReport.newCustomers)}
        ${renderReportCustomerList('Returning customers', customerReport.returningCustomers)}
      </div>
    </div>
  `;
}

function renderReportJobs(report) {
  const jobs = report.jobsReport;
  const maxCategoryCount = Math.max(1, ...jobs.mostCommonCategories.map(item => item.count));
  return `
    <div class="card reports-panel">
      <div class="card-header"><span class="card-title">Jobs Report</span></div>
      <div class="reports-chip-grid">
        ${ReportKpi({ label: 'Completed jobs', value: String(jobs.completed), tone: 'green' })}
        ${ReportKpi({ label: 'Cancelled jobs', value: String(jobs.cancelled), tone: jobs.cancelled ? 'red' : 'green' })}
        ${ReportKpi({ label: 'Open jobs', value: String(jobs.open), tone: 'blue' })}
        ${ReportKpi({ label: 'Average job value', value: fmt(jobs.averageJobValue), tone: 'amber' })}
      </div>
      <div class="reports-two-grid reports-table-gap">
        <div>
          <div class="report-list-title">Most common job categories</div>
          <div class="report-bar-list compact">
            ${jobs.mostCommonCategories.length ? jobs.mostCommonCategories.slice(0, 6).map(item => `
              <div class="report-bar-row">
                <div class="report-bar-label"><strong>${escHtml(item.category)}</strong><span>${item.count} job${item.count === 1 ? '' : 's'}</span></div>
                <div class="report-bar-track"><span style="width:${Math.max(5, Math.round((item.count / maxCategoryCount) * 100))}%"></span></div>
              </div>
            `).join('') : '<div class="report-empty-mini">No jobs in this period</div>'}
          </div>
        </div>
        <div class="table-scroll">
          <table class="data-table reports-jobs-table">
            <thead><tr><th>Job</th><th>Customer</th><th>Category</th><th>Status</th><th>Value</th></tr></thead>
            <tbody>
              ${jobs.jobs.length === 0 ? renderEmptyTableRow(5, 'No jobs in this period') : ''}
              ${jobs.jobs.slice(0, 8).map(job => `
                <tr>
                  <td><strong>#${escHtml(job.id)}</strong><div class="entity-subtitle">${escHtml(job.registration || '-')}</div></td>
                  <td>${escHtml(job.customer)}</td>
                  <td>${escHtml(job.category)}</td>
                  <td>${statusBadge(job.status)}</td>
                  <td>${fmt(job.value)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function renderReportsSectionTabs() {
  const active = normalizeReportsSection(state.reportsSection);
  return `
    <div class="dashboard-filter reports-section-tabs" role="tablist" aria-label="Report sections">
      ${REPORT_SECTIONS.map(section => `
        <button
          class="dashboard-filter-btn ${active === section.key ? 'active' : ''}"
          type="button"
          role="tab"
          aria-selected="${active === section.key ? 'true' : 'false'}"
          onclick="setReportsSection('${section.key}')"
        >${escHtml(section.label)}</button>
      `).join('')}
    </div>
  `;
}

function renderWorkerPayoutChart(workersReport) {
  const rows = workersReport.workerRows.filter(row => row.labour > 0 || row.worker).slice(0, 8);
  const maxPayout = Math.max(1, ...rows.map(row => row.payout));
  return `
    <div class="card reports-panel">
      <div class="card-header">
        <div>
          <span class="card-title">Payout by worker</span>
          <div class="dashboard-active-range">Paid invoices in selected period</div>
        </div>
        <span class="badge badge-blue">${fmt(workersReport.summary.totalPayout)}</span>
      </div>
      ${rows.length ? `
        <div class="report-bar-list worker-chart-list">
          ${rows.map(row => `
            <div class="report-bar-row worker-bar-row">
              <div class="report-bar-label"><strong>${escHtml(row.name)}</strong><span>${escHtml(row.role)} · ${row.lines} line${row.lines === 1 ? '' : 's'}</span></div>
              <div class="report-bar-track"><span style="width:${Math.max(4, Math.round((row.payout / maxPayout) * 100))}%"></span></div>
              <div class="report-bar-value"><strong>${fmt(row.payout)}</strong><span>${fmt(row.labour)} labour</span></div>
            </div>
          `).join('')}
        </div>
      ` : '<div class="dashboard-empty-state">Worker payouts will appear after paid invoices have assigned labour.</div>'}
    </div>
  `;
}

function renderWorkerDailyChart(workersReport) {
  const rows = workersReport.dailyRows.slice().reverse().slice(-14);
  const maxPayout = Math.max(1, ...rows.map(row => row.payout));
  return `
    <div class="card reports-panel">
      <div class="card-header">
        <div>
          <span class="card-title">Daily payout history</span>
          <div class="dashboard-active-range">Last active days in this range</div>
        </div>
        <span class="badge badge-green">${workersReport.dailyRows.length} days</span>
      </div>
      ${rows.length ? `
        <div class="worker-daily-chart">
          ${rows.map(row => `
            <div class="worker-daily-column">
              <div class="worker-daily-bar" style="height:${Math.max(8, Math.round((row.payout / maxPayout) * 120))}px"></div>
              <strong>${fmt(row.payout)}</strong>
              <span>${escHtml(row.label)}</span>
            </div>
          `).join('')}
        </div>
      ` : '<div class="dashboard-empty-state">No paid labour in this period.</div>'}
    </div>
  `;
}

function renderWorkerForm() {
  const editing = state.workerEditId ? getWorkerById(state.workerEditId) : null;
  return `
    <div class="card reports-panel worker-form-panel">
      <div class="card-header">
        <span class="card-title">${editing ? 'Edit worker' : 'Add worker'}</span>
        ${editing ? '<button class="btn btn-sm" onclick="cancelWorkerEdit()">Cancel</button>' : ''}
      </div>
      <div class="worker-form-grid">
        <div class="form-row"><label>First name</label><input id="worker-first-name" type="text" value="${escHtml(editing?.first_name || '')}" /></div>
        <div class="form-row"><label>Last name</label><input id="worker-last-name" type="text" value="${escHtml(editing?.last_name || '')}" /></div>
        <div class="form-row"><label>Role</label><input id="worker-position" type="text" value="${escHtml(editing?.position || '')}" placeholder="Mechanic, MOT tester..." /></div>
        <div class="form-row"><label>Labour %</label><input id="worker-percent" type="number" min="0" max="100" step="0.1" value="${escHtml(editing ? normalizeWorkerPercent(editing.commission_percent, 30) : 30)}" /></div>
        <div class="form-row"><label>Status</label><select id="worker-active"><option value="active" ${editing?.active === false ? '' : 'selected'}>Active</option><option value="inactive" ${editing?.active === false ? 'selected' : ''}>Inactive</option></select></div>
      </div>
      <div class="settings-actions" style="margin-top:12px">
        <button class="btn btn-primary" onclick="saveWorkerFromReport()">${editing ? 'Save worker' : 'Add worker'}</button>
      </div>
    </div>
  `;
}

function renderWorkersSettingsTable(workersReport) {
  return `
    <div class="card reports-panel">
      <div class="card-header"><span class="card-title">Workers</span><span class="badge badge-gray">${workersReport.workers.length}</span></div>
      <div class="table-scroll">
        <table class="data-table workers-settings-table">
          <thead><tr><th>Name</th><th>Role</th><th>Labour %</th><th>Status</th><th>Period payout</th><th>Actions</th></tr></thead>
          <tbody>
            ${workersReport.workers.length === 0 ? renderEmptyTableRow(6, 'Add your first worker to start tracking labour payout') : ''}
            ${workersReport.workers.map(worker => {
              const row = workersReport.workerRows.find(item => item.workerId === worker.id) || makeWorkerAggregationRow(worker);
              return `
                <tr>
                  <td>
                    <div class="worker-cell">
                      <span class="worker-avatar">${escHtml(getWorkerInitials(worker))}</span>
                      <div><strong>${escHtml(getWorkerDisplayName(worker))}</strong><div class="entity-subtitle">${escHtml(worker.last_name || '')}</div></div>
                    </div>
                  </td>
                  <td>${escHtml(worker.position || '-')}</td>
                  <td>${fmtPercent(worker.commission_percent)}</td>
                  <td>${renderPill(worker.active ? 'Active' : 'Inactive', worker.active ? 'green' : 'gray')}</td>
                  <td><strong>${fmt(row.payout || 0)}</strong></td>
                  <td>
                    <div class="row-actions">
                      <button class="icon-action" title="Edit worker" onclick="editWorker(${worker.id})">${uiIcon('edit')}</button>
                      <button class="icon-action" title="${worker.active ? 'Deactivate worker' : 'Activate worker'}" onclick="toggleWorkerActive(${worker.id})">${uiIcon(worker.active ? 'pause' : 'play')}</button>
                    </div>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderWorkerPayoutDetail(workersReport) {
  return `
    <div class="card reports-panel">
      <div class="card-header"><span class="card-title">Payout detail</span><span class="badge badge-green">${workersReport.assignmentRows.length} labour lines</span></div>
      <div class="table-scroll">
        <table class="data-table workers-payout-table">
          <thead><tr><th>Paid</th><th>Invoice</th><th>Job</th><th>Customer</th><th>Worker</th><th>Labour</th><th>Rate</th><th>Payout</th></tr></thead>
          <tbody>
            ${workersReport.assignmentRows.length === 0 ? renderEmptyTableRow(8, 'No paid assigned labour in this period') : ''}
            ${workersReport.assignmentRows.map(row => `
              <tr>
                <td>${fmtDate(row.paymentDate)}</td>
                <td><strong>${escHtml(row.invoiceNumber)}</strong></td>
                <td>${row.jobId ? `<button class="link-button" onclick="openJob(${Number(row.jobId)})">#${escHtml(row.jobId)}</button>` : '-'}</td>
                <td>${escHtml(row.customerName)}<div class="entity-subtitle">${escHtml(row.registration || '-')}</div></td>
                <td>${escHtml(row.workerName)}<div class="entity-subtitle">${escHtml(row.workerRole)}</div></td>
                <td>${fmt(row.labour)}</td>
                <td>${row.workerId ? fmtPercent(row.rate) : '-'}</td>
                <td><strong>${fmt(row.payout)}</strong></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderWorkerDailyHistory(workersReport) {
  return `
    <div class="card reports-panel">
      <div class="card-header"><span class="card-title">Daily history</span><span class="badge badge-blue">${workersReport.dailyRows.length} days</span></div>
      <div class="table-scroll">
        <table class="data-table workers-daily-table">
          <thead><tr><th>Date</th><th>Paid invoices</th><th>Labour lines</th><th>Labour</th><th>Payout</th></tr></thead>
          <tbody>
            ${workersReport.dailyRows.length === 0 ? renderEmptyTableRow(5, 'No worker payout history in this period') : ''}
            ${workersReport.dailyRows.map(row => `
              <tr>
                <td><strong>${fmtDate(row.date)}</strong><div class="entity-subtitle">${escHtml(row.label)}</div></td>
                <td>${row.invoices}</td>
                <td>${row.lines}</td>
                <td>${fmt(row.labour)}</td>
                <td><strong>${fmt(row.payout)}</strong></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderReportWorkers(report) {
  const workersReport = report.workersReport;
  return `
    <div class="reports-summary-grid workers-summary-grid">
      ${ReportKpi({ label: 'Active workers', value: String(workersReport.summary.activeWorkers), sub: `${workersReport.workers.length} total`, tone: 'blue' })}
      ${ReportKpi({ label: 'Paid invoices', value: String(workersReport.summary.paidInvoices), sub: report.range.label, tone: 'green' })}
      ${ReportKpi({ label: 'Labour assigned', value: fmt(workersReport.summary.totalLabour), sub: `${workersReport.summary.assignedLines} labour lines`, tone: 'amber' })}
      ${ReportKpi({ label: 'Payout due', value: fmt(workersReport.summary.totalPayout), sub: 'From paid labour only', tone: 'green' })}
    </div>
    <div class="reports-two-grid">
      ${renderWorkerPayoutChart(workersReport)}
      ${renderWorkerDailyChart(workersReport)}
    </div>
    <div class="workers-management-grid">
      ${renderWorkerForm()}
      ${renderWorkersSettingsTable(workersReport)}
    </div>
    ${renderWorkerPayoutDetail(workersReport)}
    ${renderWorkerDailyHistory(workersReport)}
  `;
}

function renderReportsBody(report) {
  if (normalizeReportsSection(state.reportsSection) === 'workers') return renderReportWorkers(report);
  return `
    ${!report.hasAnyData ? '<div class="reports-empty-banner">No report data available for this period.</div>' : ''}
    ${renderReportSummaryCards(report.summary)}
    <div class="reports-two-grid">
      ${renderReportRevenueBreakdown(report)}
      ${renderReportCategoryBreakdown(report)}
    </div>
    ${renderReportPayments(report)}
    ${renderReportCustomers(report)}
    ${renderReportJobs(report)}
  `;
}

function renderReports() {
  const report = buildReportsData();
  const activeSection = normalizeReportsSection(state.reportsSection);
  return `
    <div class="reports-shell">
      <div class="reports-toolbar">
        <div>
          <h1>Reports</h1>
          <div class="reports-period">${escHtml(report.range.label)}</div>
        </div>
        <div class="reports-actions">
          <button class="btn btn-primary" onclick="exportReportCsv()">${activeSection === 'workers' ? 'Export Workers CSV' : 'Export CSV'}</button>
          <button class="btn" onclick="exportReportPdf()">Export PDF</button>
          <button class="btn" onclick="printReport()">Print Report</button>
        </div>
      </div>
      ${renderReportsSectionTabs()}
      ${renderReportsFilterControls(report)}
      ${renderReportsBody(report)}
    </div>
  `;
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildReportsCsv(report) {
  const headers = [
    'Report period',
    'Invoice number',
    'Customer name',
    'Vehicle registration',
    'Job category',
    'Job status',
    'Invoice status',
    'Total amount',
    'Paid amount',
    'Remaining balance',
    'Invoice date',
    'Due date',
    'Payment date if available',
  ];
  const period = `${report.range.startIso} to ${report.range.endIso}`;
  const rows = report.periodInvoices.map(row => [
    period,
    row.invoiceNumber,
    row.customerName,
    row.registration,
    row.category,
    row.jobStatus,
    row.invoiceStatus,
    fmt(row.total),
    fmt(row.paid),
    fmt(row.remaining),
    row.invoiceDate,
    row.dueDate,
    row.paymentDate,
  ]);
  return '\uFEFF' + [headers, ...rows].map(row => row.map(csvEscape).join(',')).join('\r\n');
}

function buildWorkersReportCsv(report) {
  const headers = [
    'Report period',
    'Paid date',
    'Invoice number',
    'Job ID',
    'Customer name',
    'Vehicle registration',
    'Worker name',
    'Worker role',
    'Labour description',
    'Labour amount',
    'Worker rate',
    'Payout',
  ];
  const period = `${report.range.startIso} to ${report.range.endIso}`;
  const rows = report.workersReport.assignmentRows.map(row => [
    period,
    row.paymentDate,
    row.invoiceNumber,
    row.jobId || '',
    row.customerName,
    row.registration,
    row.workerName,
    row.workerRole,
    row.description,
    fmt(row.labour),
    row.workerId ? fmtPercent(row.rate) : '',
    fmt(row.payout),
  ]);
  return '\uFEFF' + [headers, ...rows].map(row => row.map(csvEscape).join(',')).join('\r\n');
}

function exportReportCsv() {
  const report = buildReportsData();
  if (normalizeReportsSection(state.reportsSection) === 'workers') {
    if (!report.workersReport.assignmentRows.length) {
      alert('No worker payout data available for this period.');
      return;
    }
    const csv = buildWorkersReportCsv(report);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `garage-crm-workers-${report.range.startIso}-to-${report.range.endIso}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Workers CSV exported');
    return;
  }
  if (!report.periodInvoices.length) {
    alert('No report data available for this period.');
    return;
  }
  const csv = buildReportsCsv(report);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `garage-crm-report-${report.range.startIso}-to-${report.range.endIso}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('CSV exported');
}

function renderReportPrintDocument(report) {
  return `
    <div class="report-print-shell">
      <div class="print-preview-toolbar">
        <button class="btn" onclick="clearReportPrintMode()">Back to app</button>
        <button class="btn btn-primary" onclick="printReport()">Print again</button>
      </div>
      <article class="report-sheet">
        <header class="report-sheet-head">
          <div>
            <div class="invoice-sheet-eyebrow">Garage CRM report</div>
            <h1 class="invoice-sheet-title">${escHtml(getGarageName())}</h1>
            <div class="invoice-sheet-subtitle">${escHtml(report.range.label)} - generated ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
          </div>
          <div class="invoice-sheet-meta">
            <div class="invoice-meta-row"><span>From</span><strong>${fmtDate(report.range.startIso)}</strong></div>
            <div class="invoice-meta-row"><span>To</span><strong>${fmtDate(report.range.endIso)}</strong></div>
            <div class="invoice-meta-row"><span>Invoices</span><strong>${report.periodInvoices.length}</strong></div>
          </div>
        </header>
        <div class="report-print-content">
          ${renderReportsBody(report)}
        </div>
      </article>
    </div>
  `;
}

function enterReportPrintMode(report) {
  const root = ensurePrintRoot();
  root.innerHTML = renderReportPrintDocument(report);
  document.body.classList.add('print-invoice-mode', 'print-report-mode');
  document.getElementById('app').classList.add('app-hidden-for-print');
  root.classList.add('print-root-active');
}

function clearReportPrintMode() {
  document.body.classList.remove('print-report-mode');
  leavePrintMode();
}

async function printReport(options = {}) {
  const report = buildReportsData();
  enterReportPrintMode(report);
  if (options.saveAsPdf) toast('Choose Save as PDF in the print dialog');
  try {
    await new Promise(resolve => setTimeout(resolve, 180));
    await Promise.resolve(window.print());
  } catch (error) {
    clearReportPrintMode();
    console.error('Report print failed', error);
    alert('Unable to open the print dialog. Restart the app and try again.');
    return;
  }
  const cleanup = () => {
    window.removeEventListener('focus', cleanup);
    setTimeout(clearReportPrintMode, 120);
  };
  window.addEventListener('focus', cleanup, { once: true });
  setTimeout(clearReportPrintMode, 10000);
}

function exportReportPdf() {
  printReport({ saveAsPdf: true });
}

function readWorkerFormPayload() {
  const firstName = String(document.getElementById('worker-first-name')?.value || '').trim();
  const lastName = String(document.getElementById('worker-last-name')?.value || '').trim();
  const position = String(document.getElementById('worker-position')?.value || '').trim();
  const commissionPercent = normalizeWorkerPercent(document.getElementById('worker-percent')?.value, 30);
  const active = String(document.getElementById('worker-active')?.value || 'active') !== 'inactive';
  return { firstName, lastName, position, commissionPercent, active };
}

async function saveWorkerFromReport() {
  const payload = readWorkerFormPayload();
  if (!payload.firstName && !payload.lastName) {
    alert('Enter worker first name or last name.');
    return;
  }
  const editId = normalizeWorkerId(state.workerEditId);
  const existing = editId ? getWorkerById(editId) : null;
  const worker = {
    id: editId,
    first_name: payload.firstName,
    last_name: payload.lastName,
    position: payload.position,
    commission_percent: payload.commissionPercent,
    active: payload.active,
    created_at: existing?.created_at || new Date().toISOString(),
  };
  try {
    await invoke('save_worker', { worker });
    state.workerEditId = null;
    await syncAfterCloudMutation();
    await loadBusinessStateFromBackend();
    toast('Worker saved');
    await renderInPlace();
  } catch (error) {
    alert(getErrorMessage(error));
  }
}

function editWorker(workerId) {
  state.workerEditId = normalizeWorkerId(workerId);
  renderInPlace();
}

function cancelWorkerEdit() {
  state.workerEditId = null;
  renderInPlace();
}

async function toggleWorkerActive(workerId) {
  const worker = getWorkerById(workerId);
  if (!worker) return;
  try {
    await invoke('save_worker', { worker: { ...worker, active: worker.active === false } });
    await syncAfterCloudMutation();
    await loadBusinessStateFromBackend();
    toast(worker.active === false ? 'Worker activated' : 'Worker deactivated');
    await renderInPlace();
  } catch (error) {
    alert(getErrorMessage(error));
  }
}

function progressPct(s) { return {New:5,Diagnosing:20,'Waiting Parts':40,'In Progress':65,Ready:100,Completed:100,Cancelled:0}[s]||0; }

// INVENTORY
async function openInventory(filter = 'all', itemId = null) {
  state.inventoryFilter = normalizeInventoryFilter(filter);
  state.searchQuery = '';
  await nav('inventory');
  if (itemId) showInventoryItemModal(itemId);
}

function setInventoryFilter(filter) {
  state.inventoryFilter = normalizeInventoryFilter(filter);
  renderInPlace();
}

async function refreshInventoryState() {
  const [items, movements] = await Promise.all([
    invoke('get_inventory_items'),
    invoke('get_inventory_movements'),
  ]);
  state.inventoryItems = items;
  state.inventoryMovements = movements;
  return { items, movements };
}

function renderInventoryFilterControls(activeFilter, counts) {
  const filters = [
    { key: 'all', label: 'All', count: counts.all },
    { key: 'low', label: 'Low Stock', count: counts.low },
    { key: 'out', label: 'Out of Stock', count: counts.out },
  ];
  return `
    <div class="dashboard-filter inventory-filter" role="group" aria-label="Inventory filter">
      ${filters.map(filter => `<button class="dashboard-filter-btn ${activeFilter === filter.key ? 'active' : ''}" aria-pressed="${activeFilter === filter.key ? 'true' : 'false'}" onclick="setInventoryFilter('${filter.key}')">${filter.label} (${filter.count})</button>`).join('')}
    </div>
  `;
}

function renderInventory() {
  const items = getInventoryItems();
  const q = state.searchQuery.toLowerCase();
  const activeFilter = normalizeInventoryFilter(state.inventoryFilter);
  const lowItems = getLowStockItems(items);
  const outItems = getOutOfStockItems(items);
  const filteredByStatus = activeFilter === 'low'
    ? lowItems
    : activeFilter === 'out'
      ? outItems
      : items;
  const filteredList = q
    ? filteredByStatus.filter(item => [
        getInventoryPartName(item),
        getInventorySku(item),
        item.category || '',
        getInventorySupplier(item),
      ].some(value => String(value || '').toLowerCase().includes(q)))
    : filteredByStatus;
  const list = sortRows(filteredList, 'inventory', {
    part: getInventoryPartName,
    sku: getInventorySku,
    qty: getInventoryQuantity,
    min: getInventoryMinimumStockLevel,
    purchase: getInventoryPurchaseCost,
    sell: getInventorySellPrice,
    margin: getInventoryMarginPercent,
    value: getInventoryValue,
    supplier: getInventorySupplier,
    status: getInventoryStockStatus,
  });
  const counts = { all: items.length, low: lowItems.length, out: outItems.length };

  return `
    <div class="inventory-shell">
      <div class="inventory-toolbar">
        <input id="search-input" type="text" placeholder="Search part name, SKU, category, supplier..." value="${escHtml(state.searchQuery)}" oninput="state.searchQuery=this.value;renderInPlace()" />
        ${renderInventoryFilterControls(activeFilter, counts)}
        <button class="btn btn-primary" onclick="showInventoryItemModal()">+ Add item</button>
      </div>

      <div class="inventory-overview-bar" aria-label="Inventory overview">
        <button class="inventory-overview-metric" onclick="openInventory('all')">
          <span>Items</span>
          <strong>${getTotalInventoryItems(items)}</strong>
        </button>
        <button class="inventory-overview-metric ${lowItems.length ? 'is-warning' : ''}" onclick="openInventory('low')">
          <span>Low</span>
          <strong>${lowItems.length}</strong>
        </button>
        <button class="inventory-overview-metric ${outItems.length ? 'is-danger' : ''}" onclick="openInventory('out')">
          <span>Out</span>
          <strong>${outItems.length}</strong>
        </button>
        <button class="inventory-overview-metric inventory-overview-value" onclick="openInventory('all')">
          <span>Value</span>
          <strong>${fmt(getTotalInventoryValue(items))}</strong>
        </button>
      </div>

      <div class="card data-table-card">
        <div class="table-scroll">
          <table class="data-table inventory-table">
            <thead><tr>${SortableTh('inventory','part','Part')}${SortableTh('inventory','sku','SKU')}${SortableTh('inventory','qty','Stock')}${SortableTh('inventory','sell','Pricing')}${SortableTh('inventory','value','Stock value')}${SortableTh('inventory','supplier','Supplier')}${SortableTh('inventory','status','Status')}<th>Actions</th></tr></thead>
            <tbody>
              ${list.length === 0 ? renderEmptyTableRow(8, 'No inventory items found') : ''}
              ${list.map(item => `
                <tr class="clickable" onclick="showInventoryItemModal(${item.id})">
                  <td>${renderEntityCell({ label: getInventoryPartName(item), meta: item.category || '', avatarKey: getInventorySku(item) || getInventoryPartName(item) })}</td>
                  <td>${renderRegChip(getInventorySku(item) || '-')}</td>
                  <td><div class="contact-stack">${renderIconMeta('box', `${fmtQty(getInventoryQuantity(item))} in stock`)}${renderIconMeta('wrench', `Min ${fmtQty(getInventoryMinimumStockLevel(item))}`)}</div></td>
                  <td><div class="contact-stack"><strong>${fmt(getInventorySellPrice(item))}</strong><span class="entity-subtitle">Cost ${fmt(getInventoryPurchaseCost(item))} / ${fmtPercent(getInventoryMarginPercent(item))}</span></div></td>
                  <td><strong>${fmt(getInventoryValue(item))}</strong></td>
                  <td>${renderIconMeta('box', getInventorySupplier(item), 'No supplier')}</td>
                  <td>${StatusBadge(getInventoryStockStatus(item))}</td>
                  <td>${renderRowActions(`showInventoryItemModal(${item.id})`, `showInventoryMovementModal(${item.id}, 'Stock In')`)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        ${renderTableFooter(list.length, 'items', filteredList.length)}
      </div>

      ${RecentInventoryMovementsWidget(getInventoryMovements())}
    </div>
  `;
}
function formatInventoryNumberInput(value) {
  const rounded = Math.round((Number(value) || 0) * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function refreshInventoryItemPricing(source = 'auto') {
  const quantityInput = document.getElementById('inv-quantity');
  const costInput = document.getElementById('inv-cost');
  const marginInput = document.getElementById('inv-margin');
  const sellInput = document.getElementById('inv-sell-price');
  const autoInput = document.getElementById('inv-price-auto');
  const valuePreview = document.getElementById('inv-value-preview');
  const retailPreview = document.getElementById('inv-retail-value-preview');
  const profitPreview = document.getElementById('inv-profit-preview');
  if (!quantityInput || !costInput || !marginInput || !sellInput || !autoInput) return;

  const quantity = parseFloat(quantityInput.value) || 0;
  const purchaseCost = parseFloat(costInput.value) || 0;
  if (source === 'margin') autoInput.checked = true;
  if (source === 'sell') autoInput.checked = false;

  const autoMode = autoInput.checked;
  if (autoMode) {
    const sellPrice = calculateInventorySellPrice(purchaseCost, parseFloat(marginInput.value) || 0);
    sellInput.value = formatInventoryNumberInput(sellPrice);
  } else if (source === 'sell' || source === 'purchase' || source === 'mode') {
    const margin = calculateInventoryMarginPercent(purchaseCost, parseFloat(sellInput.value) || 0);
    marginInput.value = formatInventoryNumberInput(Math.max(0, margin));
  }

  sellInput.readOnly = autoMode;
  sellInput.classList.toggle('input-readonly', autoMode);

  const sellPrice = parseFloat(sellInput.value) || 0;
  if (valuePreview) valuePreview.textContent = fmt(quantity * purchaseCost);
  if (retailPreview) retailPreview.textContent = fmt(quantity * sellPrice);
  if (profitPreview) profitPreview.textContent = fmt(sellPrice - purchaseCost);
}

function refreshInventoryItemValuePreview() {
  refreshInventoryItemPricing('auto');
}

function showInventoryItemModal(itemId = null, { persist = true } = {}) {
  const numericId = itemId ? Number(itemId) : null;
  const item = numericId ? getInventoryItemById(numericId) : null;
  if (numericId && !item) {
    alert('Inventory item not found');
    return;
  }
  const persistState = persist ? { kind: 'inventory-item', itemId: numericId } : state.modalState;
  const priceMode = getInventoryPriceMode(item || {});
  const marginPercent = getInventoryMarginPercent(item || {});
  const sellPrice = getInventorySellPrice(item || {});
  const autoPriceChecked = priceMode !== 'manual';
  showModal(`<div class="modal modal-wide">
    <h2>${item ? 'Edit Inventory Item' : 'Add Inventory Item'}</h2>
    <div class="form-grid">
      <div class="form-row"><label>Part name *</label><input id="inv-part-name" type="text" value="${escHtml(item ? getInventoryPartName(item) : '')}" /></div>
      <div class="form-row"><label>SKU</label><input id="inv-sku" type="text" value="${escHtml(item?.sku || '')}" /></div>
      <div class="form-row"><label>Category</label><input id="inv-category" type="text" value="${escHtml(item?.category || '')}" /></div>
      <div class="form-row"><label>Supplier</label><input id="inv-supplier" type="text" value="${escHtml(item?.supplier || '')}" /></div>
      <div class="form-row"><label>Quantity in stock</label><input id="inv-quantity" type="number" step="0.01" min="0" value="${getInventoryQuantity(item || {})}" onfocus="clearZeroNumberInput(this)" oninput="refreshInventoryItemPricing('quantity')" /></div>
      <div class="form-row"><label>Minimum stock level</label><input id="inv-minimum" type="number" step="0.01" min="0" value="${getInventoryMinimumStockLevel(item || {})}" onfocus="clearZeroNumberInput(this)" /></div>
      <div class="form-row"><label>Purchase cost</label><input id="inv-cost" type="number" step="0.01" min="0" value="${getInventoryPurchaseCost(item || {})}" onfocus="clearZeroNumberInput(this)" oninput="refreshInventoryItemPricing('purchase')" /></div>
      <div class="form-row"><label>Margin %</label><input id="inv-margin" type="number" step="0.01" min="0" value="${marginPercent}" onfocus="clearZeroNumberInput(this)" oninput="refreshInventoryItemPricing('margin')" /></div>
      <div class="form-row"><label>Sell price</label><input id="inv-sell-price" type="number" step="0.01" min="0" value="${sellPrice}" onfocus="clearZeroNumberInput(this)" oninput="refreshInventoryItemPricing('sell')" /></div>
      <div class="inventory-pricing-panel">
        <label class="inventory-price-toggle"><input id="inv-price-auto" type="checkbox" ${autoPriceChecked ? 'checked' : ''} onchange="refreshInventoryItemPricing('mode')" /> Auto retail from margin</label>
        <div class="inventory-pricing-grid">
          <div class="detail-item inventory-value-preview"><div class="dl">Stock value</div><div id="inv-value-preview" class="dv">${fmt(getInventoryValue(item || {}))}</div><small>Qty x purchase</small></div>
          <div class="detail-item inventory-value-preview"><div class="dl">Retail value</div><div id="inv-retail-value-preview" class="dv">${fmt(getInventoryRetailValue(item || {}))}</div><small>Qty x sell price</small></div>
          <div class="detail-item inventory-value-preview"><div class="dl">Profit / part</div><div id="inv-profit-preview" class="dv">${fmt(sellPrice - getInventoryPurchaseCost(item || {}))}</div><small>Sell - purchase</small></div>
        </div>
      </div>
    </div>
    <div class="form-row"><label>Notes</label><textarea id="inv-notes">${escHtml(item?.notes || '')}</textarea></div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">Cancel</button>
      ${item ? `<button class="btn" onclick="showInventoryMovementModal(${item.id}, 'Stock In')">Order / Restock</button>` : ''}
      <button class="btn btn-primary" onclick="saveInventoryItem(${numericId || 'null'})">Save</button>
    </div>
  </div>`, { persistState });
  refreshInventoryItemPricing('mode');
}

async function saveInventoryItem(itemId = null) {
  const item = {
    id: itemId || null,
    part_name: document.getElementById('inv-part-name').value.trim(),
    sku: document.getElementById('inv-sku').value.trim(),
    category: document.getElementById('inv-category').value.trim(),
    supplier: document.getElementById('inv-supplier').value.trim(),
    quantity: parseFloat(document.getElementById('inv-quantity').value) || 0,
    minimum_stock_level: parseFloat(document.getElementById('inv-minimum').value) || 0,
    purchase_cost: parseFloat(document.getElementById('inv-cost').value) || 0,
    sell_price: parseFloat(document.getElementById('inv-sell-price').value) || 0,
    margin_percent: parseFloat(document.getElementById('inv-margin').value) || 0,
    price_mode: document.getElementById('inv-price-auto').checked ? 'auto' : 'manual',
    notes: document.getElementById('inv-notes').value.trim(),
  };
  if (!item.part_name) {
    alert('Part name is required');
    return;
  }
  await invoke('save_inventory_item', { item });
  await syncAfterCloudMutation();
  closeModal();
  toast('Inventory item saved');
  await render();
}

function showInventoryMovementModal(itemId, movementType = 'Stock In', { persist = true } = {}) {
  const item = getInventoryItemById(itemId);
  if (!item) {
    alert('Inventory item not found');
    return;
  }
  const type = ['Stock In', 'Stock Out', 'Adjustment'].includes(movementType) ? movementType : 'Stock In';
  const persistState = persist ? { kind: 'inventory-movement', itemId: Number(itemId), movementType: type } : state.modalState;
  showModal(`<div class="modal">
    <h2>${escHtml(type)}: ${escHtml(getInventoryPartName(item))}</h2>
    <div class="detail-grid mb-16">
      <div class="detail-item"><div class="dl">SKU</div><div class="dv">${escHtml(getInventorySku(item))}</div></div>
      <div class="detail-item"><div class="dl">Current quantity</div><div class="dv">${fmtQty(getInventoryQuantity(item))}</div></div>
    </div>
    <div class="form-row">
      <label>Movement type</label>
      <select id="inv-movement-type">
        ${['Stock In', 'Stock Out', 'Adjustment'].map(option => `<option ${option === type ? 'selected' : ''}>${option}</option>`).join('')}
      </select>
    </div>
    <div class="form-row"><label>Quantity</label><input id="inv-movement-quantity" type="number" step="0.01" value="" /></div>
    <div class="form-row"><label>Notes</label><textarea id="inv-movement-notes" placeholder="Supplier order, job use, stock count..."></textarea></div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveInventoryMovement(${Number(itemId)})">Save movement</button>
    </div>
  </div>`, { persistState });
}

async function saveInventoryMovement(itemId) {
  const movement = {
    id: null,
    inventory_item_id: Number(itemId),
    movement_type: document.getElementById('inv-movement-type').value,
    quantity: parseFloat(document.getElementById('inv-movement-quantity').value) || 0,
    movement_date: '',
    notes: document.getElementById('inv-movement-notes').value.trim(),
  };
  await invoke('adjust_inventory_stock', { movement });
  await syncAfterCloudMutation();
  closeModal();
  toast('Stock movement saved');
  await render();
}

async function deleteInventoryItem(itemId) {
  const item = getInventoryItemById(itemId);
  if (!item) return;
  if (!confirm(`Delete ${getInventoryPartName(item)} from inventory?`)) return;
  await invoke('delete_inventory_item', { id: Number(itemId) });
  await syncAfterCloudMutation();
  closeModal();
  toast('Inventory item deleted');
  await render();
}

// ── MESSAGES ─────────────────────────────────────────────────────────────
function normalizePhoneForSms(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let phone = raw.replace(/[^\d+]/g, '');
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  if (phone.startsWith('0')) phone = `+44${phone.slice(1)}`;
  if (phone && !phone.startsWith('+') && phone.length >= 10) phone = `+${phone}`;
  return phone;
}

function validateSmsPhone(value) {
  const phone = normalizePhoneForSms(value);
  if (!phone) return { phone: '', error: 'Customer phone number is missing.' };
  if (!/^\+[1-9]\d{9,14}$/.test(phone)) {
    return { phone: '', error: 'Enter a valid phone number in UK format, e.g. 07... or +44...' };
  }
  return { phone, error: '' };
}

function isMessageStatusSuccess(status) {
  return ['sent', 'queued', 'delivered', 'accepted'].includes(String(status || '').trim().toLowerCase());
}

function getSmsProviderStatusLabel() {
  if (!isCloudSignedIn()) return 'Sign in to send SMS';
  return getCloudSession().configured ? 'SMS ready' : 'SMS setup needed';
}

function getMessageCategoryMeta(category) {
  return MESSAGE_CATEGORIES[category] || MESSAGE_CATEGORIES.custom;
}

function getMessageCategoryLabel(category) {
  return getMessageCategoryMeta(category).label;
}

function messageCategoryBadge(category) {
  const meta = getMessageCategoryMeta(category);
  return renderPill(meta.label, meta.tone);
}

function getVehicleById(vehicleId) {
  return state.vehicles.find(vehicle => String(vehicle.id) === String(vehicleId)) || null;
}

function getSyncedJobMileage(job, vehicle = null) {
  const jobMileage = parseDistanceInput(job?.mileage_in, 0);
  if (jobMileage > 0) return jobMileage;
  return parseDistanceInput((vehicle || getVehicleById(job?.vehicle_id))?.mileage, 0);
}

function mergeLocalVehicle(vehicleId, patch) {
  const index = state.vehicles.findIndex(vehicle => String(vehicle.id) === String(vehicleId));
  if (index === -1) return;
  state.vehicles[index] = { ...state.vehicles[index], ...patch };
}

function mergeLocalJob(jobId, patch) {
  const index = state.jobs.findIndex(job => String(job.id) === String(jobId));
  if (index === -1) return;
  state.jobs[index] = { ...state.jobs[index], ...patch };
}

function mergeLocalMileageForJob(job, mileage) {
  const syncedMileage = parseDistanceInput(mileage, 0);
  if (!job?.id) return;
  mergeLocalJob(job.id, { mileage_in: syncedMileage });
  if (syncedMileage > 0) mergeLocalVehicle(job.vehicle_id, { mileage: syncedMileage });
}

function normalizeJobMileageForSave(job) {
  const syncedMileage = getSyncedJobMileage(job);
  return { ...job, mileage_in: syncedMileage };
}

function getMessageVehicleLabel(vehicleLike) {
  const makeModel = [vehicleLike?.make, vehicleLike?.model].filter(Boolean).join(' ').trim();
  const registration = vehicleLike?.registration || '';
  return [makeModel, registration].filter(Boolean).join(' ') || 'your vehicle';
}

function formatAmountForSms(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return '';
  return amount.toFixed(2);
}

function getJobAmountDue(job) {
  if (!job) return 0;
  const invoice = state.invoices.find(item => Number(item.job_id) === Number(job.id));
  if (invoice && Number(invoice.total) > 0) return Number(invoice.total);
  if (Number(state.selectedJob) === Number(job.id) && Array.isArray(state.jobLines) && state.jobLines.length) {
    const subtotal = state.jobLines.reduce((sum, line) => sum + Number(line.qty || 0) * Number(line.unit_price || 0), 0);
    return subtotal + getVatAmount(subtotal);
  }
  return Number(job.subtotal || 0);
}

function parseDateOnly(dateValue) {
  if (!dateValue) return null;
  const date = new Date(`${dateValue}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysUntilDate(dateValue) {
  const target = parseDateOnly(dateValue);
  if (!target) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetDay = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  return Math.ceil((targetDay - today) / (24 * 60 * 60 * 1000));
}

function isWithinLeadWindow(dateValue, leadDays) {
  const days = daysUntilDate(dateValue);
  return days !== null && days >= 0 && days <= leadDays;
}

function getMessageTemplate(category) {
  const settings = getMessageSettings();
  if (category === 'booking_confirmation' || category === 'booking_reminder') return settings.booking_template || DEFAULT_MESSAGE_TEMPLATES.booking_confirmation;
  if (category === 'job_completed' || category === 'ready_collection') return settings.completed_template || settings.ready_template || DEFAULT_MESSAGE_TEMPLATES.job_completed;
  if (category === 'mot_reminder') return settings.mot_template || DEFAULT_MESSAGE_TEMPLATES.mot_reminder;
  if (category === 'service_reminder') return settings.service_template || DEFAULT_MESSAGE_TEMPLATES.service_reminder;
  return DEFAULT_MESSAGE_TEMPLATES.custom;
}

function renderMessageTemplate(template, context = {}) {
  const safe = value => (value === undefined || value === null ? '' : String(value));
  const garagePhone = getGarageContactPhone();
  const values = {
    garage_name: getGarageName(),
    garage_phone: garagePhone,
    customer_name: context.customer_name || context.customer || 'there',
    customer_phone: context.customer_phone || '',
    vehicle_reg: context.vehicle_reg || context.registration || '',
    vehicle_make: context.vehicle_make || '',
    vehicle_model: context.vehicle_model || '',
    booking_date: context.booking_date || context.date || '',
    booking_time: context.booking_time || context.time || '',
    mot_due_date: context.mot_due_date || '',
    service_due_date: context.service_due_date || '',
    amount_due: context.amount_due || '',
    garage: getGarageName(),
    customer: context.customer || context.customer_name || 'there',
    vehicle: context.vehicle || [context.vehicle_make, context.vehicle_model, context.vehicle_reg || context.registration].filter(Boolean).join(' ') || 'your vehicle',
    registration: context.registration || context.vehicle_reg || '',
    date: context.date || context.booking_date || context.mot_due_date || context.service_due_date || '',
    time: context.time || context.booking_time || '',
    service: context.service || 'your booking',
    phone: context.phone || context.garage_phone || garagePhone,
  };
  return String(template || '')
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, key) => safe(values[key]))
    .replace(/\{([a-z_]+)\}/gi, (_, key) => safe(values[key]));
}

function getBookingMessageContext(booking, client, vehicle) {
  const customerName = client?.name || booking?.client_name || 'there';
  const customerPhone = client?.phone || '';
  const vehicleReg = (vehicle || booking)?.registration || '';
  const garagePhone = getGarageContactPhone();
  return {
    customer_name: customerName,
    customer_phone: customerPhone,
    vehicle_reg: vehicleReg,
    vehicle_make: (vehicle || booking)?.make || '',
    vehicle_model: (vehicle || booking)?.model || '',
    booking_date: fmtDate(booking?.date),
    booking_time: booking?.time || '',
    garage_name: getGarageName(),
    garage_phone: garagePhone,
    customer: customerName,
    vehicle: getMessageVehicleLabel(vehicle || booking),
    registration: vehicleReg,
    date: fmtDate(booking?.date),
    time: booking?.time || '',
    service: booking?.reason || 'your booking',
    phone: garagePhone,
  };
}

function getVehicleMessageContext(vehicle, client, dueDate, serviceLabel) {
  const customerName = client?.name || vehicle?.client_name || 'there';
  const garagePhone = getGarageContactPhone();
  const formattedDueDate = fmtDate(dueDate);
  return {
    customer_name: customerName,
    customer_phone: client?.phone || '',
    vehicle_reg: vehicle?.registration || '',
    vehicle_make: vehicle?.make || '',
    vehicle_model: vehicle?.model || '',
    mot_due_date: serviceLabel === 'MOT' ? formattedDueDate : '',
    service_due_date: serviceLabel === 'service' ? formattedDueDate : '',
    garage_name: getGarageName(),
    garage_phone: garagePhone,
    customer: customerName,
    vehicle: getMessageVehicleLabel(vehicle),
    registration: vehicle?.registration || '',
    date: formattedDueDate,
    time: '',
    service: serviceLabel,
    phone: garagePhone,
  };
}

function getJobCompletedMessageContext(job, client, vehicle, amountDue = '') {
  const customerName = client?.name || job?.client_name || 'there';
  const garagePhone = getGarageContactPhone();
  return {
    customer_name: customerName,
    customer_phone: client?.phone || '',
    vehicle_reg: (vehicle || job)?.registration || '',
    vehicle_make: (vehicle || job)?.make || '',
    vehicle_model: (vehicle || job)?.model || '',
    amount_due: amountDue,
    garage_name: getGarageName(),
    garage_phone: garagePhone,
    customer: customerName,
    vehicle: getMessageVehicleLabel(vehicle || job),
    registration: (vehicle || job)?.registration || '',
    date: '',
    time: '',
    service: job?.complaint || job?.booking_reason || 'your vehicle',
    phone: garagePhone,
  };
}

function getReadyMessageContext(job, client, vehicle) {
  return getJobCompletedMessageContext(job, client, vehicle, formatAmountForSms(getJobAmountDue(job)));
}

function makeMessageAction({ id, category, recipientName, phone, title, subtitle, relatedType, relatedId, dateValue, context, customerId = null, vehicleId = null, bookingId = null, jobCardId = null, reminderType = '', reminderStage = '', manualOnly = false }) {
  const body = renderMessageTemplate(getMessageTemplate(category), context);
  const phoneCheck = validateSmsPhone(phone);
  return {
    id,
    category,
    recipientName,
    phone: phone || '',
    normalizedPhone: phoneCheck.phone,
    phoneError: phoneCheck.error,
    title,
    subtitle,
    relatedType,
    relatedId,
    dateValue,
    body,
    customerId,
    vehicleId,
    bookingId,
    jobCardId,
    reminderType,
    reminderStage,
    manualOnly,
  };
}

function getEnabledReminderStageForDate(dateValue) {
  const settings = getMessageSettings();
  const days = daysUntilDate(dateValue);
  const stages = [
    { days: 30, key: '30_days', enabled: settings.reminder_30_days },
    { days: 14, key: '14_days', enabled: settings.reminder_14_days },
    { days: 7, key: '7_days', enabled: settings.reminder_7_days },
    { days: 0, key: 'due_today', enabled: settings.reminder_due_today },
  ];
  const match = stages.find(stage => stage.enabled && days === stage.days);
  return match ? match.key : '';
}

function getReminderStageLabel(stage) {
  const labels = {
    '30_days': '30 days',
    '14_days': '14 days',
    '7_days': '7 days',
    due_today: 'due today',
  };
  return labels[stage] || '';
}

function getDueBucketLabel(dateValue, typeLabel) {
  const days = daysUntilDate(dateValue);
  if (days === null) return `${typeLabel} date missing`;
  if (days < 0) return `Overdue ${typeLabel}`;
  if (days === 0) return `${typeLabel} due today`;
  return `${typeLabel} due in ${days} day${days === 1 ? '' : 's'}`;
}

function getReminderDashboardCounts() {
  return state.vehicles.reduce((acc, vehicle) => {
    const motDays = daysUntilDate(vehicle.mot_due);
    const serviceDays = daysUntilDate(vehicle.service_due);
    if (motDays !== null) {
      if (motDays < 0) acc.overdueMot += 1;
      else if (motDays <= 30) acc.motDueSoon += 1;
    }
    if (serviceDays !== null) {
      if (serviceDays < 0) acc.overdueService += 1;
      else if (serviceDays <= 30) acc.serviceDueSoon += 1;
    }
    return acc;
  }, { motDueSoon: 0, serviceDueSoon: 0, overdueMot: 0, overdueService: 0 });
}

function getMessageActions() {
  const settings = getMessageSettings();
  const actions = [];
  if (settings.booking_reminders_enabled) {
    const leadDays = normalizeLeadDays(settings.booking_days_before, DEFAULT_MESSAGE_SETTINGS.booking_days_before);
    state.bookings
      .filter(booking => booking.status !== 'Cancelled' && isWithinLeadWindow(booking.date, leadDays))
      .forEach(booking => {
        const client = getClientById(booking.client_id) || { name: booking.client_name, phone: '' };
        const vehicle = getVehicleById(booking.vehicle_id) || booking;
        actions.push(makeMessageAction({
          id: `booking-${booking.id}`,
          category: 'booking_confirmation',
          recipientName: client.name || booking.client_name || 'Customer',
          phone: client.phone || '',
          title: `${booking.time || ''} ${booking.client_name || client.name || 'Customer'}`.trim(),
          subtitle: `${getMessageVehicleLabel(vehicle)} - ${booking.reason || 'Booking'}`,
          relatedType: 'booking',
          relatedId: booking.id,
          dateValue: booking.date,
          customerId: booking.client_id || client.id || null,
          vehicleId: booking.vehicle_id || vehicle.id || null,
          bookingId: booking.id,
          context: getBookingMessageContext(booking, client, vehicle),
        }));
      });
  }
  if (settings.ready_messages_enabled) {
    state.jobs
      .filter(job => job.status === 'Completed' || job.status === 'Ready')
      .forEach(job => {
        const client = getClientById(job.client_id) || { name: job.client_name, phone: '' };
        const vehicle = getVehicleById(job.vehicle_id) || job;
        const amountDue = formatAmountForSms(getJobAmountDue(job));
        actions.push(makeMessageAction({
          id: `job-completed-${job.id}`,
          category: 'job_completed',
          recipientName: client.name || job.client_name || 'Customer',
          phone: client.phone || '',
          title: `Job #${job.id} ${job.status === 'Completed' ? 'completed' : 'ready'}`,
          subtitle: `${getMessageVehicleLabel(vehicle)} - ${amountDue ? `amount due £${amountDue}` : 'amount missing'}`,
          relatedType: 'job',
          relatedId: job.id,
          dateValue: job.est_completion || job.date_opened || '',
          customerId: job.client_id || client.id || null,
          vehicleId: job.vehicle_id || vehicle.id || null,
          jobCardId: job.id,
          context: getJobCompletedMessageContext(job, client, vehicle, amountDue),
        }));
      });
  }
  if (settings.mot_reminders_enabled) {
    state.vehicles
      .filter(vehicle => {
        const days = daysUntilDate(vehicle.mot_due);
        return days !== null && days <= 30;
      })
      .forEach(vehicle => {
        const client = getClientById(vehicle.client_id) || { name: vehicle.client_name, phone: '' };
        const stage = getEnabledReminderStageForDate(vehicle.mot_due);
        actions.push(makeMessageAction({
          id: `mot-${vehicle.id}-${stage || (daysUntilDate(vehicle.mot_due) < 0 ? 'overdue' : 'due-soon')}`,
          category: 'mot_reminder',
          recipientName: client.name || vehicle.client_name || 'Customer',
          phone: client.phone || '',
          title: getDueBucketLabel(vehicle.mot_due, 'MOT'),
          subtitle: `${getMessageVehicleLabel(vehicle)}${stage ? ` - ${getReminderStageLabel(stage)} reminder` : ''}`,
          relatedType: 'vehicle',
          relatedId: vehicle.id,
          dateValue: vehicle.mot_due,
          customerId: vehicle.client_id || client.id || null,
          vehicleId: vehicle.id,
          reminderType: 'MOT',
          reminderStage: stage,
          context: getVehicleMessageContext(vehicle, client, vehicle.mot_due, 'MOT'),
        }));
      });
  }
  if (settings.service_reminders_enabled) {
    state.vehicles
      .filter(vehicle => {
        const days = daysUntilDate(vehicle.service_due);
        return days !== null && days <= 30;
      })
      .forEach(vehicle => {
        const client = getClientById(vehicle.client_id) || { name: vehicle.client_name, phone: '' };
        const stage = getEnabledReminderStageForDate(vehicle.service_due);
        actions.push(makeMessageAction({
          id: `service-${vehicle.id}-${stage || (daysUntilDate(vehicle.service_due) < 0 ? 'overdue' : 'due-soon')}`,
          category: 'service_reminder',
          recipientName: client.name || vehicle.client_name || 'Customer',
          phone: client.phone || '',
          title: getDueBucketLabel(vehicle.service_due, 'Service'),
          subtitle: `${getMessageVehicleLabel(vehicle)}${stage ? ` - ${getReminderStageLabel(stage)} reminder` : ''}`,
          relatedType: 'vehicle',
          relatedId: vehicle.id,
          dateValue: vehicle.service_due,
          customerId: vehicle.client_id || client.id || null,
          vehicleId: vehicle.id,
          reminderType: 'SERVICE',
          reminderStage: stage,
          context: getVehicleMessageContext(vehicle, client, vehicle.service_due, 'service'),
        }));
      });
  }
  return actions.sort((a, b) => String(a.dateValue || '').localeCompare(String(b.dateValue || '')));
}

function getMessageActionById(actionId) {
  return getMessageActions().find(action => action.id === actionId) || null;
}

function getMessageLogRelatedType(entry) {
  return entry?.related_type || entry?.relatedType || '';
}

function getMessageLogRelatedId(entry) {
  return Number(entry?.related_id ?? entry?.relatedId ?? 0);
}

function normalizeMessageCategoryKey(category) {
  if (category === 'booking_reminder') return 'booking_confirmation';
  if (category === 'ready_collection') return 'job_completed';
  return category || 'custom';
}

function hasMessageBeenSent(action) {
  return (state.messageLog || []).some(entry => (
    normalizeMessageCategoryKey(entry.category) === normalizeMessageCategoryKey(action.category)
    && getMessageLogRelatedType(entry) === action.relatedType
    && getMessageLogRelatedId(entry) === Number(action.relatedId)
    && (!action.reminderStage || String(entry.reminder_stage || entry.reminderStage || '') === String(action.reminderStage))
    && (!action.reminderType || String(entry.scheduled_for || entry.scheduledFor || '') === String(action.dateValue || ''))
    && isMessageStatusSuccess(entry.status)
  ));
}

function isAutomaticSmsReminderAction(action, settings = getMessageSettings()) {
  return Boolean(
    action?.reminderStage
    && !hasMessageBeenSent(action)
    && (
      (action.category === 'mot_reminder' && settings.mot_reminders_enabled)
      || (action.category === 'service_reminder' && settings.service_reminders_enabled)
    )
  );
}

function getAutomaticSmsReminderActions({ requireSendTime = false, requirePhone = false } = {}) {
  const settings = getMessageSettings();
  if (!settings.sms_enabled || !isMessagingConfigured()) return [];
  if (requireSendTime && !isAutomaticReminderSendTimeDue(settings.automatic_reminder_time)) return [];
  return getMessageActions().filter(action => (
    isAutomaticSmsReminderAction(action, settings)
    && (!requirePhone || action.normalizedPhone)
  ));
}

function buildSmsPayloadFromAction(action) {
  return {
    category: action.category,
    to: action.normalizedPhone || normalizePhoneForSms(action.phone),
    body: action.body,
    recipientName: action.recipientName || '',
    relatedType: action.relatedType || '',
    relatedId: action.relatedId || null,
    scheduledFor: action.dateValue || '',
    customerId: action.customerId || null,
    vehicleId: action.vehicleId || null,
    bookingId: action.bookingId || null,
    jobCardId: action.jobCardId || null,
    reminderType: action.reminderType || '',
    reminderStage: action.reminderStage || '',
  };
}

async function sendSms({ to, message, category = 'custom', recipientName = '', relatedType = '', relatedId = null, customerId = null, vehicleId = null, bookingId = null, jobCardId = null, reminderType = '', reminderStage = '', scheduledFor = '', manual = false } = {}) {
  const settings = getMessageSettings();
  if (!settings.sms_enabled) {
    throw new Error('SMS notifications are disabled in Settings.');
  }
  if (manual && !settings.manual_sms_enabled) {
    throw new Error('Manual SMS sending is disabled in Settings.');
  }
  if (!isMessagingConfigured()) {
    throw new Error('Sign in before sending SMS.');
  }
  await ensureSmsAllowedForBilling();
  const phoneCheck = validateSmsPhone(to);
  if (phoneCheck.error) throw new Error(phoneCheck.error);
  const body = String(message || '').trim();
  if (!body) throw new Error('SMS body is required.');
  const result = await invoke('send_sms_message', {
    message: {
      category,
      to: phoneCheck.phone,
      body,
      recipientName,
      relatedType,
      relatedId,
      scheduledFor,
      customerId,
      vehicleId,
      bookingId,
      jobCardId,
      reminderType,
      reminderStage,
    }
  });
  if (isMessageStatusSuccess(result?.status)) {
    invalidateBillingSnapshot();
    state.billingSnapshot = null;
  }
  return result;
}

async function sendSmsActionObject(action, { manual = false, silent = false } = {}) {
  if (!action) return null;
  const payload = buildSmsPayloadFromAction(action);
  const result = await sendSms({
    to: payload.to,
    message: payload.body,
    category: payload.category,
    recipientName: payload.recipientName,
    relatedType: payload.relatedType,
    relatedId: payload.relatedId,
    scheduledFor: payload.scheduledFor,
    customerId: payload.customerId,
    vehicleId: payload.vehicleId,
    bookingId: payload.bookingId,
    jobCardId: payload.jobCardId,
    reminderType: payload.reminderType,
    reminderStage: payload.reminderStage,
    manual,
  });
  await refreshMessagesState();
  await syncAfterCloudMutation();
  if (!silent) {
    toast(isMessageStatusSuccess(result?.status) ? 'SMS sent successfully' : `SMS ${String(result?.status || 'logged').toLowerCase()}`);
  }
  return result;
}

async function sendAutomaticBookingSms(booking, client, vehicle) {
  const settings = getMessageSettings();
  if (!settings.sms_enabled || !settings.auto_booking_sms) return;
  const action = makeMessageAction({
    id: `booking-${booking.id}`,
    category: 'booking_confirmation',
    recipientName: client?.name || booking.client_name || 'Customer',
    phone: client?.phone || '',
    title: '',
    subtitle: '',
    relatedType: 'booking',
    relatedId: booking.id,
    dateValue: booking.date,
    customerId: booking.client_id || client?.id || null,
    vehicleId: booking.vehicle_id || vehicle?.id || null,
    bookingId: booking.id,
    context: getBookingMessageContext(booking, client, vehicle),
  });
  if (!action.normalizedPhone || hasMessageBeenSent(action)) return;
  try {
    await sendSmsActionObject(action, { silent: true });
    toast('Booking SMS sent successfully');
  } catch (error) {
    await refreshMessagesState().catch(() => {});
    toast(`SMS failed: ${String(error)}`);
  }
}

async function sendAutomaticJobReadySms(job, { requireAutoEnabled = true } = {}) {
  const settings = getMessageSettings();
  if (!settings.sms_enabled) {
    if (!requireAutoEnabled) toast('SMS notifications are disabled in Settings.');
    return;
  }
  if (requireAutoEnabled && !settings.auto_job_completed_sms) return;
  if (!isMessagingConfigured()) {
    if (!requireAutoEnabled) toast('Sign in before sending SMS.');
    return;
  }
  const amountDue = formatAmountForSms(getJobAmountDue(job));
  if (!amountDue) {
    toast('Amount due is missing. Please add payment amount before sending SMS.');
    return;
  }
  const client = getClientById(job.client_id) || { name: job.client_name, phone: '' };
  const vehicle = getVehicleById(job.vehicle_id) || job;
  const action = makeMessageAction({
    id: `job-completed-${job.id}`,
    category: 'job_completed',
    recipientName: client.name || job.client_name || 'Customer',
    phone: client.phone || '',
    title: '',
    subtitle: '',
    relatedType: 'job',
    relatedId: job.id,
    dateValue: job.est_completion || job.date_opened || '',
    customerId: job.client_id || client.id || null,
    vehicleId: job.vehicle_id || vehicle.id || null,
    jobCardId: job.id,
    context: getJobCompletedMessageContext(job, client, vehicle, amountDue),
  });
  if (!action.normalizedPhone) {
    if (!requireAutoEnabled) toast(action.phoneError || 'Customer phone number is missing.');
    return;
  }
  if (hasMessageBeenSent(action)) {
    if (!requireAutoEnabled) toast('Ready SMS has already been sent.');
    return;
  }
  try {
    await sendSmsActionObject(action, { manual: !requireAutoEnabled, silent: true });
    toast('Ready SMS sent successfully');
  } catch (error) {
    await refreshMessagesState().catch(() => {});
    toast(`SMS failed: ${String(error)}`);
  }
}

async function processAutomaticSmsReminders() {
  const settings = getMessageSettings();
  scheduleAutomaticSmsReminderCheck(settings);
  if (!settings.sms_enabled || !isMessagingConfigured()) return;
  const dueActions = getAutomaticSmsReminderActions({ requireSendTime: true, requirePhone: true });
  for (const action of dueActions) {
    try {
      await sendSmsActionObject(action, { silent: true });
    } catch (error) {
      await refreshMessagesState().catch(() => {});
      await syncAfterCloudMutation().catch(() => {});
      console.warn('Automatic SMS reminder failed', error);
    }
  }
}

function getReminderSendTimeDate(sendTime, baseDate = new Date()) {
  const [hours, minutes] = normalizeReminderSendTime(sendTime).split(':').map(Number);
  return new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), hours, minutes, 0, 0);
}

function isAutomaticReminderSendTimeDue(sendTime) {
  return new Date() >= getReminderSendTimeDate(sendTime);
}

function getNextAutomaticReminderDelayMs(sendTime) {
  const now = new Date();
  let next = getReminderSendTimeDate(sendTime, now);
  if (next <= now) {
    next = new Date(next.getTime() + 24 * 60 * 60 * 1000);
  }
  return Math.max(1000, next.getTime() - now.getTime());
}

function scheduleAutomaticSmsReminderCheck(settings = getMessageSettings()) {
  if (automaticSmsReminderTimerId) {
    clearTimeout(automaticSmsReminderTimerId);
    automaticSmsReminderTimerId = null;
  }
  if (!settings.sms_enabled || !isMessagingConfigured()) return;
  const delay = getNextAutomaticReminderDelayMs(settings.automatic_reminder_time);
  automaticSmsReminderTimerId = setTimeout(() => {
    automaticSmsReminderTimerId = null;
    void processAutomaticSmsReminders();
  }, delay);
}

async function refreshMessagesState() {
  const [messageSettings, messageLog] = await Promise.all([
    invoke('get_message_settings'),
    invoke('get_message_log', { limit: 100 }),
  ]);
  state.messageSettings = messageSettings;
  state.messageLog = messageLog;
}

async function sendMessageAction(actionId) {
  const action = getMessageActionById(actionId);
  if (!action) return;
  if (!action.normalizedPhone) {
    alert(action.phoneError || 'This customer has no SMS-ready phone number.');
    return;
  }
  if (action.category === 'job_completed' && !/\bAmount to pay:\s*£\d/i.test(action.body)) {
    alert('Amount due is missing. Please add payment amount before sending SMS.');
    return;
  }
  if (hasMessageBeenSent(action)) {
    alert('This SMS has already been sent.');
    return;
  }
  const settings = getMessageSettings();
  if (!settings.manual_sms_enabled) {
    alert('Manual SMS sending is disabled in Settings.');
    return;
  }
  try {
    await sendSmsActionObject(action, { manual: true });
    if (state.screen === 'messages') await renderInPlace();
  } catch (error) {
    await refreshMessagesState().catch(() => {});
    toast(`SMS failed: ${String(error)}`);
    alert(String(error));
    if (state.screen === 'messages') await renderInPlace();
  }
}

function setMessageFilter(filter) {
  state.messageFilter = filter;
  state.messageQuickFilter = 'all';
  renderInPlace();
}

function setMessageQuickFilter(filter) {
  state.messageQuickFilter = filter || 'all';
  if (state.messageQuickFilter !== 'all') {
    state.messageFilter = 'all';
  }
  renderInPlace();
}

function getMessageActionSentLog(action) {
  const logged = getMessageLogForAction(action);
  return logged && isMessageStatusSuccess(logged.status) ? logged : null;
}

function hasMessageActionSentToday(action) {
  const logged = getMessageActionSentLog(action);
  return Boolean(logged && String(logged.sent_at || logged.created_at || '').slice(0, 10) === formatDateInputValue());
}

function hasMessageActionFailed(action) {
  const logged = getMessageLogForAction(action);
  return String(logged?.status || '').toLowerCase() === 'failed';
}

function isMessageActionDueSoon(action) {
  const days = daysUntilDate(action.dateValue);
  return days !== null && days >= 0 && days <= 30;
}

function isMessageActionOverdue(action) {
  const days = daysUntilDate(action.dateValue);
  return days !== null && days < 0;
}

function filterMessageActionsForQuickFilter(actions, quickFilter) {
  const filter = quickFilter || 'all';
  if (filter === 'ready') return actions.filter(action => action.normalizedPhone && !hasMessageBeenSent(action));
  if (filter === 'sent_today') return actions.filter(hasMessageActionSentToday);
  if (filter === 'failed') return actions.filter(hasMessageActionFailed);
  if (filter === 'mot_due') return actions.filter(action => action.category === 'mot_reminder' && isMessageActionDueSoon(action));
  if (filter === 'service_due') return actions.filter(action => action.category === 'service_reminder' && isMessageActionDueSoon(action));
  if (filter === 'overdue') return actions.filter(action => ['mot_reminder', 'service_reminder'].includes(action.category) && isMessageActionOverdue(action));
  if (filter === 'overdue_mot') return actions.filter(action => action.category === 'mot_reminder' && isMessageActionOverdue(action));
  if (filter === 'overdue_service') return actions.filter(action => action.category === 'service_reminder' && isMessageActionOverdue(action));
  if (filter === 'auto_stage') return actions.filter(action => isAutomaticSmsReminderAction(action));
  return actions;
}

function filterMessageLogEntriesForQuickFilter(entries, quickFilter) {
  const filter = quickFilter || 'all';
  if (filter === 'sent_today') {
    return entries.filter(entry => isMessageStatusSuccess(entry.status) && String(entry.sent_at || entry.created_at || '').slice(0, 10) === formatDateInputValue());
  }
  if (filter === 'failed') {
    return entries.filter(entry => String(entry.status || '').toLowerCase() === 'failed');
  }
  if (filter === 'mot_due' || filter === 'overdue_mot') {
    return entries.filter(entry => normalizeMessageCategoryKey(entry.category) === 'mot_reminder');
  }
  if (filter === 'service_due' || filter === 'overdue_service') {
    return entries.filter(entry => normalizeMessageCategoryKey(entry.category) === 'service_reminder');
  }
  if (filter === 'overdue') {
    return entries.filter(entry => ['mot_reminder', 'service_reminder'].includes(normalizeMessageCategoryKey(entry.category)) && daysUntilDate(entry.scheduled_for || entry.scheduledFor) < 0);
  }
  if (filter === 'auto_stage') {
    return entries.filter(entry => ['mot_reminder', 'service_reminder'].includes(normalizeMessageCategoryKey(entry.category)) && String(entry.reminder_stage || entry.reminderStage || '').trim());
  }
  return entries;
}

function getMessageQuickFilterLabel(filter) {
  const labels = {
    ready: 'Ready to send',
    sent_today: 'Sent today',
    failed: 'Failed messages',
    mot_due: 'MOT due soon',
    service_due: 'Service due soon',
    overdue: 'Overdue reminders',
    overdue_mot: 'Overdue MOT',
    overdue_service: 'Overdue service',
    auto_stage: 'Automatic stages',
  };
  return labels[filter] || 'All messages';
}

function renderMessageKpiCard({ label, value, hint = '', filter = 'all', active = false, tone = '' }) {
  return `
    <button type="button" class="message-kpi ${tone ? `is-${tone}` : ''} ${active ? 'is-active' : ''}" onclick="setMessageQuickFilter('${filter}')">
      <span>${escHtml(label)}</span>
      <strong>${escHtml(String(value))}</strong>
    </button>
  `;
}

function renderMessageFilterControls(activeFilter, counts) {
  const filters = [
    ['all', 'All', counts.all],
    ['booking_confirmation', 'Bookings', counts.booking_confirmation],
    ['job_completed', 'Jobs', counts.job_completed],
    ['mot_reminder', 'MOT', counts.mot_reminder],
    ['service_reminder', 'Service', counts.service_reminder],
  ];
  return `<div class="segmented message-filter">${filters.map(([value, label, count]) => `<button class="btn btn-sm ${activeFilter === value ? 'btn-primary' : ''}" onclick="setMessageFilter('${value}')">${label} ${count || 0}</button>`).join('')}</div>`;
}

function getMessageLogForAction(action) {
  return (state.messageLog || []).find(entry => (
    normalizeMessageCategoryKey(entry.category) === normalizeMessageCategoryKey(action.category)
    && getMessageLogRelatedType(entry) === action.relatedType
    && getMessageLogRelatedId(entry) === Number(action.relatedId)
    && (!action.reminderStage || String(entry.reminder_stage || entry.reminderStage || '') === String(action.reminderStage))
    && (!action.reminderType || String(entry.scheduled_for || entry.scheduledFor || '') === String(action.dateValue || ''))
  )) || null;
}

function renderMessageActionCard(action) {
  const sent = hasMessageBeenSent(action);
  const logged = getMessageLogForAction(action);
  const settings = getMessageSettings();
  const canSend = settings.sms_enabled && settings.manual_sms_enabled && isMessagingConfigured() && action.normalizedPhone && !sent;
  const phoneCopy = action.normalizedPhone || action.phone || 'No phone';
  const statusPill = sent
    ? renderPill('Sent', 'green')
    : (logged?.status ? StatusBadge(logged.status) : renderPill('Not sent', 'gray'));
  return `
    <div class="message-action-card ${sent ? 'is-sent' : ''}">
      <div class="message-action-main">
        <div class="message-action-heading">
          <div class="message-action-title">${escHtml(action.title)}</div>
          <div class="message-action-sub">${escHtml(action.subtitle)}</div>
        </div>
        <div class="message-action-meta">
          ${renderIconMeta('phone', phoneCopy, 'No phone')}
          ${action.dateValue ? renderIconMeta('calendar', fmtDate(action.dateValue), 'No date') : ''}
          ${messageCategoryBadge(action.category)}
        </div>
        <div class="message-preview" title="${escHtml(action.body)}">${escHtml(action.body)}</div>
      </div>
      <div class="message-action-state">${statusPill}</div>
      <div class="message-action-footer">
        <button class="btn btn-sm" onclick="showSmsComposeModal('${action.id}')">Edit</button>
        <button class="btn btn-sm btn-primary" onclick="sendMessageAction('${action.id}')" ${canSend ? '' : 'disabled'}>${sent ? 'Already sent' : 'Send SMS'}</button>
      </div>
    </div>
  `;
}

function renderMessageLogTable(entries) {
  return `
    <div class="card data-table-card message-log-card">
      <div class="table-scroll">
        <table class="data-table message-log-table">
          <thead><tr><th>When</th><th>Recipient</th><th>Type</th><th>Message</th><th>Status</th><th>Reference</th></tr></thead>
          <tbody>
            ${entries.length === 0 ? renderEmptyTableRow(6, 'No SMS messages logged yet') : ''}
            ${entries.map(entry => `
              <tr>
                <td>${fmtDateTime(entry.sent_at || entry.created_at)}</td>
                <td>${renderEntityCell({ label: entry.recipient_name || entry.recipient_phone || 'Customer', meta: entry.recipient_phone || '', avatarKey: entry.recipient_phone || entry.recipient_name })}</td>
                <td>${messageCategoryBadge(entry.category || 'custom')}</td>
                <td><div class="message-log-body">${escHtml(entry.body || '')}${entry.error ? `<div class="entity-subtitle text-red">${escHtml(entry.error)}</div>` : ''}</div></td>
                <td>${StatusBadge(entry.status || 'Draft')}</td>
                <td><span class="entity-subtitle">${escHtml(entry.provider_message_id || '-')}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      ${renderTableFooter(entries.length, 'messages', state.messageLog.length)}
    </div>
  `;
}

function renderMessagePreferencesCard({ compact = false } = {}) {
  const settings = getMessageSettings();
  const configured = isMessagingConfigured();
  const autoEnabled = settings.sms_enabled && configured;
  return `
    <div class="card settings-card message-settings-card">
      <div class="settings-card-head">
        <div>
          <div class="settings-kicker">SMS</div>
          <div class="settings-title">SMS Notifications</div>
        </div>
        <span class="badge ${autoEnabled ? 'badge-green' : (configured ? 'badge-amber' : 'badge-gray')}">${autoEnabled ? 'Auto SMS On' : getSmsProviderStatusLabel()}</span>
      </div>
      <div class="message-settings-grid">
        <label class="toggle-row"><input id="msg-sms-enabled" type="checkbox" ${settings.sms_enabled ? 'checked' : ''} /> Enable SMS notifications</label>
        <label class="toggle-row"><input id="msg-auto-booking" type="checkbox" ${settings.auto_booking_sms ? 'checked' : ''} /> Auto SMS after new booking</label>
        <label class="toggle-row"><input id="msg-auto-completed" type="checkbox" ${settings.auto_job_completed_sms ? 'checked' : ''} /> Auto SMS when job marked ready</label>
        <label class="toggle-row"><input id="msg-mot-enabled" type="checkbox" ${settings.mot_reminders_enabled ? 'checked' : ''} /> Auto MOT reminders</label>
        <label class="toggle-row"><input id="msg-service-enabled" type="checkbox" ${settings.service_reminders_enabled ? 'checked' : ''} /> Auto service reminders</label>
      </div>
      <div class="form-grid">
        <div class="form-row"><label>Default garage/business name</label><input type="text" value="${escHtml(getGarageName())}" disabled /></div>
        <div class="form-row"><label>Garage reply phone</label><input id="msg-garage-phone" type="text" value="${escHtml(settings.garage_phone)}" placeholder="+44..." /></div>
        <div class="form-row"><label>Booking queue lookahead days</label><input id="msg-booking-days" type="number" min="0" max="365" value="${normalizeLeadDays(settings.booking_days_before, DEFAULT_MESSAGE_SETTINGS.booking_days_before)}" /></div>
        <div class="form-row"><label>Auto reminder send time</label><input id="msg-reminder-send-time" type="time" value="${escHtml(normalizeReminderSendTime(settings.automatic_reminder_time))}" /></div>
      </div>
      <div class="message-stage-grid">
        <label class="toggle-row"><input id="msg-stage-30" type="checkbox" ${settings.reminder_30_days ? 'checked' : ''} /> 30 days before</label>
        <label class="toggle-row"><input id="msg-stage-14" type="checkbox" ${settings.reminder_14_days ? 'checked' : ''} /> 14 days before</label>
        <label class="toggle-row"><input id="msg-stage-7" type="checkbox" ${settings.reminder_7_days ? 'checked' : ''} /> 7 days before</label>
        <label class="toggle-row"><input id="msg-stage-due" type="checkbox" ${settings.reminder_due_today ? 'checked' : ''} /> Due date</label>
      </div>
      ${compact ? '' : `
        <div class="message-template-grid">
          <div class="form-row"><label>Booking confirmation SMS</label><textarea id="msg-booking-template" rows="4">${escHtml(settings.booking_template)}</textarea></div>
          <div class="form-row"><label>MOT template</label><textarea id="msg-mot-template" rows="3">${escHtml(settings.mot_template)}</textarea></div>
          <div class="form-row"><label>Service template</label><textarea id="msg-service-template" rows="3">${escHtml(settings.service_template)}</textarea></div>
          <div class="form-row"><label>Ready for collection SMS</label><textarea id="msg-completed-template" rows="3">${escHtml(settings.completed_template || settings.ready_template)}</textarea></div>
        </div>
        <div class="message-template-card-inline">
          <div class="entity-subtitle">Template variables</div>
          <div class="message-placeholder-list">
            ${SMS_TEMPLATE_VARIABLES.map(item => `<span>${escHtml(item)}</span>`).join('')}
          </div>
        </div>
      `}
      <div class="settings-actions">
        <button class="btn btn-primary" onclick="saveMessageSettings()">Save preferences</button>
      </div>
    </div>
  `;
}

function renderMessages() {
  const configured = isMessagingConfigured();
  const actions = getMessageActions();
  const counts = actions.reduce((acc, action) => {
    acc.all += 1;
    acc[action.category] = (acc[action.category] || 0) + 1;
    return acc;
  }, { all: 0, booking_confirmation: 0, job_completed: 0, mot_reminder: 0, service_reminder: 0 });
  const activeFilter = state.messageFilter || 'all';
  const quickFilter = state.messageQuickFilter || 'all';
  const categoryActions = activeFilter === 'all' ? actions : actions.filter(action => action.category === activeFilter);
  const filteredActions = filterMessageActionsForQuickFilter(categoryActions, quickFilter);
  const filteredLogEntries = filterMessageLogEntriesForQuickFilter(state.messageLog || [], quickFilter);
  const sentToday = (state.messageLog || []).filter(entry => isMessageStatusSuccess(entry.status) && String(entry.sent_at || entry.created_at || '').slice(0, 10) === formatDateInputValue()).length;
  const failed = (state.messageLog || []).filter(entry => String(entry.status || '').toLowerCase() === 'failed').length;
  const reminderCounts = getReminderDashboardCounts();
  const autoStagePending = getAutomaticSmsReminderActions();
  const autoStageDueNow = getAutomaticSmsReminderActions({ requireSendTime: true });
  const readyActions = actions.filter(action => action.normalizedPhone && !hasMessageBeenSent(action));
  const motDueActions = actions.filter(action => action.category === 'mot_reminder' && isMessageActionDueSoon(action));
  const serviceDueActions = actions.filter(action => action.category === 'service_reminder' && isMessageActionDueSoon(action));
  const overdueMotActions = actions.filter(action => action.category === 'mot_reminder' && isMessageActionOverdue(action));
  const overdueServiceActions = actions.filter(action => action.category === 'service_reminder' && isMessageActionOverdue(action));
  return `
    <div class="messages-shell">
      <div class="messages-toolbar">
        <div>
          <h1>Messages</h1>
        </div>
        <div class="messages-toolbar-actions">
          <button class="btn btn-primary" onclick="showSmsComposeModal()">+ New SMS</button>
        </div>
      </div>

      <div class="message-kpi-grid">
        ${renderMessageKpiCard({ label: 'SMS status', value: getMessageSettings().sms_enabled && configured ? 'Enabled' : getSmsProviderStatusLabel(), hint: 'Show all', filter: 'all', active: quickFilter === 'all' && activeFilter === 'all' })}
        ${renderMessageKpiCard({ label: 'Ready', value: readyActions.length, hint: 'Can send now', filter: 'ready', active: quickFilter === 'ready' })}
        ${renderMessageKpiCard({ label: 'Auto stages', value: autoStagePending.length, filter: 'auto_stage', active: quickFilter === 'auto_stage' })}
        ${renderMessageKpiCard({ label: 'Sent today', value: sentToday, hint: 'History', filter: 'sent_today', active: quickFilter === 'sent_today' })}
        ${renderMessageKpiCard({ label: 'Failed', value: failed, hint: 'History', filter: 'failed', active: quickFilter === 'failed', tone: failed ? 'danger' : '' })}
        ${renderMessageKpiCard({ label: 'MOT due', value: motDueActions.length || reminderCounts.motDueSoon, hint: 'Due soon', filter: 'mot_due', active: quickFilter === 'mot_due' })}
        ${renderMessageKpiCard({ label: 'Service due', value: serviceDueActions.length || reminderCounts.serviceDueSoon, hint: 'Due soon', filter: 'service_due', active: quickFilter === 'service_due' })}
        ${renderMessageKpiCard({ label: 'Overdue', value: overdueMotActions.length + overdueServiceActions.length || reminderCounts.overdueMot + reminderCounts.overdueService, hint: 'MOT + service', filter: 'overdue', active: quickFilter === 'overdue', tone: (overdueMotActions.length + overdueServiceActions.length || reminderCounts.overdueMot + reminderCounts.overdueService) ? 'danger' : '' })}
      </div>

      <div class="card message-queue-card">
        <div class="message-queue-head">
          <div>
            <div class="card-title">Reminder queue</div>
            <div class="entity-subtitle">${filteredActions.length} item${filteredActions.length === 1 ? '' : 's'} in ${escHtml(getMessageQuickFilterLabel(quickFilter).toLowerCase())}</div>
          </div>
          ${renderMessageFilterControls(activeFilter, counts)}
        </div>
        <div class="message-action-list">
          ${filteredActions.length === 0 ? '<div class="empty-state">No reminders due in this view</div>' : filteredActions.map(renderMessageActionCard).join('')}
        </div>
      </div>

      ${renderMessageLogTable(filteredLogEntries)}
    </div>
  `;
}

async function saveMessageSettings() {
  const settings = buildMessageSettingsPayload({
    sms_enabled: document.getElementById('msg-sms-enabled')?.checked,
    manual_sms_enabled: true,
    auto_booking_sms: document.getElementById('msg-auto-booking')?.checked,
    auto_job_completed_sms: document.getElementById('msg-auto-completed')?.checked,
    booking_reminders_enabled: true,
    ready_messages_enabled: true,
    mot_reminders_enabled: document.getElementById('msg-mot-enabled')?.checked,
    service_reminders_enabled: document.getElementById('msg-service-enabled')?.checked,
    reminder_30_days: document.getElementById('msg-stage-30')?.checked,
    reminder_14_days: document.getElementById('msg-stage-14')?.checked,
    reminder_7_days: document.getElementById('msg-stage-7')?.checked,
    reminder_due_today: document.getElementById('msg-stage-due')?.checked,
    garage_phone: document.getElementById('msg-garage-phone')?.value,
    booking_days_before: document.getElementById('msg-booking-days')?.value,
    automatic_reminder_time: document.getElementById('msg-reminder-send-time')?.value,
    booking_template: document.getElementById('msg-booking-template')?.value || getMessageSettings().booking_template,
    mot_template: document.getElementById('msg-mot-template')?.value || getMessageSettings().mot_template,
    service_template: document.getElementById('msg-service-template')?.value || getMessageSettings().service_template,
    completed_template: document.getElementById('msg-completed-template')?.value || getMessageSettings().completed_template,
    ready_template: document.getElementById('msg-completed-template')?.value || getMessageSettings().completed_template || getMessageSettings().ready_template,
  });
  try {
    state.messageSettings = await invoke('save_message_settings', { settings });
    state.autoSmsReminderRunKey = '';
    await syncAfterCloudMutation();
    toast('Messaging settings saved');
    await render();
  } catch (error) {
    alert(String(error));
  }
}

function showTestSmsModal() {
  showSmsComposeModal();
}

function prefillSmsRecipient(clientId) {
  const client = getClientById(parseInt(clientId, 10));
  if (!client) return;
  const nameInput = document.getElementById('sms-recipient-name');
  const phoneInput = document.getElementById('sms-recipient-phone');
  const customerInput = document.getElementById('sms-customer-id');
  if (nameInput) nameInput.value = client.name || '';
  if (phoneInput) phoneInput.value = client.phone || '';
  if (customerInput) customerInput.value = client.id || '';
  updateSmsComposeTemplate(document.getElementById('sms-category')?.value || 'custom');
}

function buildSmsComposeContext() {
  const clientId = parseInt(document.getElementById('sms-customer-id')?.value || document.getElementById('sms-client')?.value || '', 10);
  const vehicleId = parseInt(document.getElementById('sms-vehicle-id')?.value || '', 10);
  const bookingId = parseInt(document.getElementById('sms-booking-id')?.value || '', 10);
  const jobCardId = parseInt(document.getElementById('sms-job-card-id')?.value || '', 10);
  const client = getClientById(clientId) || { name: document.getElementById('sms-recipient-name')?.value || 'there', phone: document.getElementById('sms-recipient-phone')?.value || '' };
  const booking = bookingId ? getBookingById(bookingId) : null;
  const job = jobCardId ? state.jobs.find(item => item.id === jobCardId) : null;
  const vehicle = getVehicleById(vehicleId || booking?.vehicle_id || job?.vehicle_id) || booking || job || {};
  const category = document.getElementById('sms-category')?.value || '';
  const reminderType = document.getElementById('sms-reminder-type')?.value || '';
  if (booking) return getBookingMessageContext(booking, client, vehicle);
  if (job) return getJobCompletedMessageContext(job, client, vehicle, formatAmountForSms(getJobAmountDue(job)));
  if (category === 'mot_reminder' || reminderType === 'MOT') return getVehicleMessageContext(vehicle, client, vehicle?.mot_due || document.getElementById('sms-scheduled-for')?.value || '', 'MOT');
  if (category === 'service_reminder' || reminderType === 'SERVICE') return getVehicleMessageContext(vehicle, client, vehicle?.service_due || document.getElementById('sms-scheduled-for')?.value || '', 'service');
  return {
    ...getVehicleMessageContext(vehicle, client, vehicle?.mot_due || vehicle?.service_due || '', ''),
    customer_name: client.name || 'there',
    customer_phone: client.phone || '',
  };
}

function updateSmsComposeTemplate(category = 'custom') {
  const bodyInput = document.getElementById('sms-body');
  if (!bodyInput) return;
  bodyInput.value = renderMessageTemplate(getMessageTemplate(category), buildSmsComposeContext());
  const count = document.getElementById('sms-compose-count');
  if (count) count.textContent = `${bodyInput.value.length} chars`;
}

function buildSmsComposeActionFromOptions(options = {}) {
  const booking = options.bookingId ? getBookingById(Number(options.bookingId)) : null;
  const job = options.jobCardId ? state.jobs.find(item => item.id === Number(options.jobCardId)) : null;
  const vehicle = getVehicleById(Number(options.vehicleId || booking?.vehicle_id || job?.vehicle_id)) || booking || job || null;
  const client = getClientById(Number(options.clientId || booking?.client_id || job?.client_id || vehicle?.client_id)) || { name: booking?.client_name || job?.client_name || vehicle?.client_name || '', phone: '' };
  const category = options.category || (booking ? 'booking_confirmation' : (job ? 'job_completed' : (options.reminderType === 'MOT' ? 'mot_reminder' : (options.reminderType === 'SERVICE' ? 'service_reminder' : 'custom'))));
  const context = booking
    ? getBookingMessageContext(booking, client, vehicle)
    : (job ? getJobCompletedMessageContext(job, client, vehicle, formatAmountForSms(getJobAmountDue(job))) : getVehicleMessageContext(vehicle || {}, client, options.scheduledFor || vehicle?.mot_due || vehicle?.service_due || '', options.reminderType === 'MOT' ? 'MOT' : 'service'));
  const relatedType = booking ? 'booking' : (job ? 'job' : (vehicle ? 'vehicle' : ''));
  const relatedId = booking?.id || job?.id || vehicle?.id || '';
  return {
    id: '',
    category,
    recipientName: client.name || '',
    phone: client.phone || options.phone || '',
    title: '',
    subtitle: '',
    relatedType,
    relatedId,
    dateValue: options.scheduledFor || booking?.date || vehicle?.mot_due || vehicle?.service_due || '',
    body: renderMessageTemplate(getMessageTemplate(category), context),
    customerId: client.id || options.clientId || null,
    vehicleId: vehicle?.id || options.vehicleId || null,
    bookingId: booking?.id || options.bookingId || null,
    jobCardId: job?.id || options.jobCardId || null,
    reminderType: options.reminderType || '',
    reminderStage: options.reminderStage || '',
  };
}

function showSmsComposeModal(actionId = '', options = {}) {
  if (typeof actionId === 'object' && actionId !== null) {
    options = actionId;
    actionId = '';
  }
  const action = actionId ? getMessageActionById(actionId) : null;
  const composeAction = action || buildSmsComposeActionFromOptions(options);
  const category = composeAction?.category || 'custom';
  const selectedClientId = composeAction?.customerId || '';
  const body = composeAction?.body || renderMessageTemplate(DEFAULT_MESSAGE_TEMPLATES.custom, buildSmsComposeContext());
  showModal(`<div class="modal modal-wide">
    <h2>${action ? 'Edit SMS' : 'New SMS'}</h2>
    <input id="sms-related-type" type="hidden" value="${escHtml(composeAction?.relatedType || '')}" />
    <input id="sms-related-id" type="hidden" value="${escHtml(composeAction?.relatedId || '')}" />
    <input id="sms-customer-id" type="hidden" value="${escHtml(composeAction?.customerId || '')}" />
    <input id="sms-vehicle-id" type="hidden" value="${escHtml(composeAction?.vehicleId || '')}" />
    <input id="sms-booking-id" type="hidden" value="${escHtml(composeAction?.bookingId || '')}" />
    <input id="sms-job-card-id" type="hidden" value="${escHtml(composeAction?.jobCardId || '')}" />
    <input id="sms-reminder-type" type="hidden" value="${escHtml(composeAction?.reminderType || '')}" />
    <input id="sms-reminder-stage" type="hidden" value="${escHtml(composeAction?.reminderStage || '')}" />
    <input id="sms-scheduled-for" type="hidden" value="${escHtml(composeAction?.dateValue || '')}" />
    <div class="form-grid">
      <div class="form-row"><label>Customer</label>
        <select id="sms-client" onchange="prefillSmsRecipient(this.value)">
          <option value="">Manual recipient</option>
          ${state.clients.map(client => `<option value="${client.id}" ${String(selectedClientId) === String(client.id) ? 'selected' : ''}>${escHtml(client.name)} - ${escHtml(client.phone || 'No phone')}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>Message type</label>
        <select id="sms-category" onchange="updateSmsComposeTemplate(this.value)">
          ${Object.entries(MESSAGE_CATEGORIES).map(([value, meta]) => `<option value="${value}" ${category === value ? 'selected' : ''}>${escHtml(meta.label)}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>Recipient name</label><input id="sms-recipient-name" type="text" value="${escHtml(composeAction?.recipientName || '')}" /></div>
      <div class="form-row"><label>Phone</label><input id="sms-recipient-phone" type="text" value="${escHtml(composeAction?.phone || '')}" placeholder="+44..." /></div>
    </div>
    <div class="form-row"><label>Preview / message</label><textarea id="sms-body" rows="6">${escHtml(body)}</textarea></div>
    <div class="message-compose-meta">
      <span id="sms-compose-count">${body.length} chars</span>
      <span>${getSmsProviderStatusLabel()}</span>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="sendSmsFromCompose()">Send SMS</button>
    </div>
  </div>`);
  document.getElementById('sms-body')?.addEventListener('input', event => {
    const count = document.getElementById('sms-compose-count');
    if (count) count.textContent = `${event.target.value.length} chars`;
  });
}

async function sendSmsFromCompose() {
  const phoneInput = document.getElementById('sms-recipient-phone')?.value || '';
  const phoneCheck = validateSmsPhone(phoneInput);
  const body = String(document.getElementById('sms-body')?.value || '').trim();
  if (phoneCheck.error) {
    alert(phoneCheck.error);
    return;
  }
  if (!body) {
    alert('Message body is required.');
    return;
  }
  if (document.getElementById('sms-category')?.value === 'job_completed' && !/\bAmount to pay:\s*£\d/i.test(body)) {
    alert('Amount due is missing. Please add payment amount before sending SMS.');
    return;
  }
  const relatedIdRaw = document.getElementById('sms-related-id')?.value || '';
  try {
    const result = await sendSms({
      category: document.getElementById('sms-category')?.value || 'custom',
      to: phoneCheck.phone,
      message: body,
      recipientName: document.getElementById('sms-recipient-name')?.value || '',
      relatedType: document.getElementById('sms-related-type')?.value || '',
      relatedId: relatedIdRaw ? Number(relatedIdRaw) : null,
      scheduledFor: document.getElementById('sms-scheduled-for')?.value || '',
      customerId: Number(document.getElementById('sms-customer-id')?.value || 0) || null,
      vehicleId: Number(document.getElementById('sms-vehicle-id')?.value || 0) || null,
      bookingId: Number(document.getElementById('sms-booking-id')?.value || 0) || null,
      jobCardId: Number(document.getElementById('sms-job-card-id')?.value || 0) || null,
      reminderType: document.getElementById('sms-reminder-type')?.value || '',
      reminderStage: document.getElementById('sms-reminder-stage')?.value || '',
      manual: true,
    });
    await refreshMessagesState();
    await syncAfterCloudMutation();
    closeModal();
    toast(isMessageStatusSuccess(result?.status) ? 'SMS sent successfully' : `SMS ${String(result?.status || 'logged').toLowerCase()}`);
    if (state.screen === 'messages') await renderInPlace();
  } catch (error) {
    await refreshMessagesState().catch(() => {});
    toast(`SMS failed: ${String(error)}`);
    alert(String(error));
  }
}

function showCustomerSmsModal(clientId) {
  showSmsComposeModal({ clientId: Number(clientId), category: 'custom' });
}

function showVehicleSmsModal(vehicleId, reminderType = '') {
  const vehicle = getVehicleById(Number(vehicleId));
  if (!vehicle) return;
  const scheduledFor = reminderType === 'MOT' ? vehicle.mot_due : (reminderType === 'SERVICE' ? vehicle.service_due : '');
  showSmsComposeModal({
    clientId: vehicle.client_id,
    vehicleId: vehicle.id,
    category: reminderType === 'MOT' ? 'mot_reminder' : (reminderType === 'SERVICE' ? 'service_reminder' : 'custom'),
    reminderType,
    scheduledFor,
  });
}

function showBookingSmsModal(bookingId) {
  const booking = getBookingById(Number(bookingId));
  if (!booking) return;
  showSmsComposeModal({ clientId: booking.client_id, vehicleId: booking.vehicle_id, bookingId: booking.id, category: 'booking_confirmation', scheduledFor: booking.date });
}

function showJobCompletedSmsModal(jobId) {
  const job = state.jobs.find(item => item.id === Number(jobId));
  if (!job) return;
  if (!formatAmountForSms(getJobAmountDue(job))) {
    alert('Amount due is missing. Please add payment amount before sending SMS.');
    return;
  }
  showSmsComposeModal({ clientId: job.client_id, vehicleId: job.vehicle_id, jobCardId: job.id, category: 'job_completed' });
}

function getSmsHistoryForEntity({ customerId = null, vehicleId = null } = {}) {
  return (state.messageLog || [])
    .filter(entry => {
      const entryCustomerId = Number(entry.customer_id ?? entry.customerId ?? 0);
      const entryVehicleId = Number(entry.vehicle_id ?? entry.vehicleId ?? 0);
      return (customerId && entryCustomerId === Number(customerId)) || (vehicleId && entryVehicleId === Number(vehicleId));
    })
    .slice()
    .sort((a, b) => String(b.sent_at || b.created_at || '').localeCompare(String(a.sent_at || a.created_at || '')));
}

function renderSmsHistoryList(entries, emptyLabel = 'No SMS history yet') {
  return `
    <div class="sms-history-list">
      ${entries.length === 0 ? `<div class="empty-state sms-history-empty">${escHtml(emptyLabel)}</div>` : entries.slice(0, 8).map(entry => `
        <div class="sms-history-row">
          <div>
            <div class="sms-history-title">${escHtml(getMessageCategoryLabel(entry.category || 'custom'))}</div>
            <div class="sms-history-body">${escHtml(entry.body || '')}</div>
            ${entry.error ? `<div class="entity-subtitle text-red">${escHtml(entry.error)}</div>` : ''}
          </div>
          <div class="sms-history-meta">
            ${StatusBadge(entry.status || 'Draft')}
            <span>${fmtDateTime(entry.sent_at || entry.created_at)}</span>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// ── CLIENTS ───────────────────────────────────────────────────────────────
function getClientVehiclesForList(clientId) {
  return state.vehicles
    .filter(vehicle => String(vehicle.client_id) === String(clientId))
    .slice()
    .sort((a, b) => String(a.registration || '').localeCompare(String(b.registration || '')));
}

function getVehicleMakeModel(vehicle) {
  return [vehicle?.make, vehicle?.model].filter(Boolean).join(' ').trim();
}

function getClientVehicleSortText(client) {
  const vehicles = getClientVehiclesForList(client.id);
  if (!vehicles.length) return '';
  const vehicle = vehicles[0];
  return [getVehicleMakeModel(vehicle), vehicle.registration].filter(Boolean).join(' ');
}

function renderClientVehicleCell(client) {
  const vehicles = getClientVehiclesForList(client.id);
  if (!vehicles.length) return renderVehicleStack({ registration: '-' });
  const vehicle = vehicles[0];
  const extraCount = vehicles.length - 1;
  return renderVehicleStack({
    make: vehicle.make,
    model: vehicle.model,
    registration: vehicle.registration,
    meta: extraCount ? `+${extraCount} more` : '',
  });
}

function renderClientBalanceCell(client) {
  const balance = Number(client.balance || 0);
  if (balance > 0) return renderPill(`Overdue ${fmt(balance)}`, 'red');
  if (client.last_visit) return renderPill('Paid', 'green');
  return renderPill('No visits yet', 'gray');
}

function getClientAccountFilter(client) {
  if (Number(client.balance || 0) > 0) return 'unpaid';
  if (client.last_visit) return 'paid';
  return 'no-visits';
}

function getClientLastVisitAge(client) {
  if (!client.last_visit) return null;
  const date = new Date(`${client.last_visit}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const visitStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.max(0, Math.round((todayStart - visitStart) / (24 * 60 * 60 * 1000)));
}

function setClientStatusFilter(filter) {
  state.clientStatusFilter = ['all', 'paid', 'unpaid', 'no-visits'].includes(filter) ? filter : 'all';
  renderInPlace();
}

function setClientVehicleFilter(filter) {
  state.clientVehicleFilter = ['all', 'with', 'without'].includes(filter) ? filter : 'all';
  renderInPlace();
}

function setClientLastVisitFilter(filter) {
  state.clientLastVisitFilter = ['any', '30', '90', 'none'].includes(filter) ? filter : 'any';
  renderInPlace();
}

function renderClients() {
  const q = state.searchQuery.toLowerCase();
  const statusFilter = state.clientStatusFilter || 'all';
  const vehicleFilter = state.clientVehicleFilter || 'all';
  const lastVisitFilter = state.clientLastVisitFilter || 'any';
  const searchedList = q ? state.clients.filter(c => [
    c.name,
    c.phone,
    c.email,
    c.company,
    getClientVehicleSortText(c),
  ].some(value => String(value || '').toLowerCase().includes(q))) : state.clients;
  const filteredList = searchedList.filter(client => {
    const vehicles = getClientVehiclesForList(client.id);
    if (statusFilter !== 'all' && getClientAccountFilter(client) !== statusFilter) return false;
    if (vehicleFilter === 'with' && !vehicles.length) return false;
    if (vehicleFilter === 'without' && vehicles.length) return false;
    const lastVisitAge = getClientLastVisitAge(client);
    if (lastVisitFilter === 'none' && lastVisitAge !== null) return false;
    if (lastVisitFilter === '30' && (lastVisitAge === null || lastVisitAge > 30)) return false;
    if (lastVisitFilter === '90' && (lastVisitAge === null || lastVisitAge > 90)) return false;
    return true;
  });
  const list = sortRows(filteredList, 'clients', {
    client: c => c.name,
    contact: c => `${c.phone || ''} ${c.email || ''}`,
    vehicle: getClientVehicleSortText,
    last_visit: c => c.last_visit,
    balance: c => c.balance || 0,
  });
  return `
  <div class="list-page-head">
    <div>
      <h1>Customers</h1>
      <div class="dashboard-active-range">${list.length} of ${state.clients.length} customers</div>
    </div>
    <button class="btn btn-primary" onclick="showClientModal()">+ Add customer</button>
  </div>
  <div class="list-toolbar">
    <input id="search-input" class="toolbar-field" type="text" placeholder="Search by name, phone, email or reg..." value="${escHtml(state.searchQuery)}" oninput="state.searchQuery=this.value;renderInPlace()" />
    <select class="toolbar-select" aria-label="Account status" onchange="setClientStatusFilter(this.value)">
      <option value="all" ${statusFilter === 'all' ? 'selected' : ''}>Status: All</option>
      <option value="paid" ${statusFilter === 'paid' ? 'selected' : ''}>Status: Paid</option>
      <option value="unpaid" ${statusFilter === 'unpaid' ? 'selected' : ''}>Status: Unpaid</option>
      <option value="no-visits" ${statusFilter === 'no-visits' ? 'selected' : ''}>Status: No visits</option>
    </select>
    <select class="toolbar-select" aria-label="Vehicle filter" onchange="setClientVehicleFilter(this.value)">
      <option value="all" ${vehicleFilter === 'all' ? 'selected' : ''}>Vehicle: All</option>
      <option value="with" ${vehicleFilter === 'with' ? 'selected' : ''}>Vehicle: With vehicle</option>
      <option value="without" ${vehicleFilter === 'without' ? 'selected' : ''}>Vehicle: No vehicle</option>
    </select>
    <select class="toolbar-select" aria-label="Last visit filter" onchange="setClientLastVisitFilter(this.value)">
      <option value="any" ${lastVisitFilter === 'any' ? 'selected' : ''}>Last visit: Any</option>
      <option value="30" ${lastVisitFilter === '30' ? 'selected' : ''}>Last visit: 30 days</option>
      <option value="90" ${lastVisitFilter === '90' ? 'selected' : ''}>Last visit: 90 days</option>
      <option value="none" ${lastVisitFilter === 'none' ? 'selected' : ''}>Last visit: None</option>
    </select>
  </div>
  <div class="card data-table-card">
    <div class="table-scroll">
    <table class="data-table clients-table"><thead><tr>${SortableTh('clients','client','Customer')}${SortableTh('clients','contact','Contact')}${SortableTh('clients','vehicle','Vehicle')}${SortableTh('clients','last_visit','Last visit')}${SortableTh('clients','balance','Account')}<th>Actions</th></tr></thead><tbody>
    ${list.length === 0 ? renderEmptyTableRow(6, 'No customers found') : ''}
    ${list.map(c=>`
    <tr class="clickable" onclick="openClient(${c.id})">
      <td>${renderEntityCell({ label: c.name, meta: c.company || '', avatarKey: c.id || c.name })}</td>
      <td>${renderContactCell(c.phone, c.email)}</td>
      <td>${renderClientVehicleCell(c)}</td>
      <td>${renderDateCell(c.last_visit)}</td>
      <td>${renderClientBalanceCell(c)}</td>
      <td><div class="row-actions">${renderMoreAction(`showClientModal(${c.id})`, 'Customer actions')}</div></td>
    </tr>`).join('')}
    </tbody></table>
    </div>
    ${renderTableFooter(list.length, 'customers', filteredList.length)}
  </div>`;
}
function renderClientProfile() {
  const c = state.clients.find(x => x.id === state.selectedClient);
  if (!c) return '<p>Customer not found</p>';
  const vehs = state.vehicles.filter(v => v.client_id === c.id);
  const jobs = state.jobs.filter(j => j.client_id === c.id);
  const bookings = getClientBookings(c.id);
  const invs = state.invoices.filter(i => jobs.some(j => j.id === i.job_id));
  const totalSpent = invs.reduce((sum, invoice) => sum + getInvoicePaidAmount(invoice, getInvoiceTotalAmount(invoice)), 0);
  const balance = invs.reduce((sum, invoice) => sum + getInvoiceBalanceDue(invoice, getInvoiceTotalAmount(invoice)), 0);
  const smsHistory = getSmsHistoryForEntity({ customerId: c.id });
  return `
  <button class="btn back-btn" onclick="state.selectedClient=null;nav('clients')">← Back to customers</button>
  <div class="two-col">
    <div>
      <div class="card">
        <div class="flex gap-12" style="margin-bottom:14px">
          <div class="avatar" style="width:44px;height:44px;font-size:15px">${initials(c.name)}</div>
          <div><div style="font-size:16px;font-weight:500">${escHtml(c.name)}</div><div class="text-sm text-muted">${escHtml(c.company||'Personal customer')}</div></div>
        </div>
        <div class="detail-grid">
          <div class="detail-item"><div class="dl">Phone</div><div class="dv">${escHtml(c.phone||'—')}</div></div>
          <div class="detail-item"><div class="dl">Email</div><div class="dv">${escHtml(c.email||'—')}</div></div>
          <div class="detail-item"><div class="dl">Address</div><div class="dv">${escHtml(c.address||'—')}</div></div>
          <div class="detail-item"><div class="dl">Total spent</div><div class="dv text-green" style="font-weight:500">${fmt(totalSpent)}</div></div>
          ${balance>0?`<div class="detail-item"><div class="dl">Outstanding</div><div class="dv text-red" style="font-weight:500">${fmt(balance)}</div></div>`:''}
        </div>
        ${c.notes?`<div style="margin-top:12px;padding-top:12px;border-top:0.5px solid var(--border)"><div class="dl">Notes</div><div class="dv">${escHtml(c.notes)}</div></div>`:''}
        <div style="margin-top:12px;display:flex;gap:8px">
          <button class="btn btn-sm" onclick="showClientModal(${c.id})">Edit</button>
          <button class="btn btn-sm btn-primary" onclick="showJobModal(null,${c.id})">+ New Job</button>
          <button class="btn btn-sm" onclick="showCustomerSmsModal(${c.id})">Send SMS</button>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">Vehicles (${vehs.length})</span><button class="btn btn-sm" onclick="showVehicleModal(null,${c.id})">+ Add vehicle</button></div>
        ${vehs.length === 0 ? '<div class="text-sm text-muted">No vehicles</div>' : vehs.map(v=>`
        <div style="padding:10px 0;border-bottom:0.5px solid var(--border)">
          <div class="flex gap-8" style="justify-content:space-between;align-items:flex-start">
            <div><div style="font-size:13px;font-weight:500">${escHtml(v.registration)} — ${escHtml(v.make)} ${escHtml(v.model)} ${v.year}</div>
            <div class="text-sm text-muted">${escHtml(v.engine)} · ${escHtml(v.fuel_type)} · ${fmtDistance(v.mileage)}</div></div>
            <div class="row-actions">
              ${v.mot_due && new Date(v.mot_due) < new Date(Date.now()+30*24*60*60*1000) ? `<span class="badge badge-red">MOT ${fmtDate(v.mot_due)}</span>` : `<span class="badge badge-gray">MOT ${fmtDate(v.mot_due)}</span>`}
              <button class="btn btn-sm" onclick="showVehicleModal(${v.id})">Edit</button>
              <button class="btn btn-sm btn-danger" onclick="deleteVehicle(${v.id})">Delete</button>
            </div>
          </div>
        </div>`).join('')}
      </div>
    </div>
    <div class="card">
      <div class="card-header"><span class="card-title">History</span></div>
      <div class="card-title" style="margin-bottom:10px">Booking history</div>
      ${bookings.length === 0 ? '<div class="empty-state">No bookings yet</div>' : `
      <table><thead><tr><th>Date</th><th>Time</th><th>Vehicle</th><th>Service</th><th>Status</th><th>Actions</th></tr></thead><tbody>
      ${bookings.map(b=>`<tr class="clickable" onclick="showBookingModal(${b.id})"><td>${fmtDate(b.date)}</td><td>${escHtml(b.time||'-')}</td><td>${escHtml(b.registration||'-')}</td><td>${escHtml((b.reason||'').slice(0,45)||'-')}</td><td>${statusBadge(b.status)}</td><td><div class="row-actions"><button class="btn btn-sm" onclick="event.stopPropagation();showBookingModal(${b.id})">Edit</button><button class="btn btn-sm btn-danger" onclick="event.stopPropagation();deleteBooking(${b.id})">Delete</button></div></td></tr>`).join('')}
      </tbody></table>`}
      <div class="card-title" style="margin:18px 0 10px;padding-top:18px;border-top:0.5px solid var(--border)">Work history</div>
      ${jobs.length === 0 ? '<div class="empty-state">No jobs yet</div>' : `
      <table><thead><tr><th>Date</th><th>Vehicle</th><th>Status</th><th>Complaint</th><th>Total</th></tr></thead><tbody>
      ${jobs.map(j=>{
        const inv = invs.find(i=>i.job_id===j.id);
        return `<tr class="clickable" onclick="openJob(${j.id})"><td>${fmtDate(j.date_opened)}</td><td>${escHtml(j.registration)}</td><td>${statusBadge(j.status)}</td><td>${escHtml((j.complaint||'').slice(0,35))}</td><td>${inv?fmt(inv.total):'—'}</td></tr>`;
      }).join('')}
      </tbody></table>`}
      <div class="card-title" style="margin:18px 0 10px;padding-top:18px;border-top:0.5px solid var(--border)">SMS history</div>
      ${renderSmsHistoryList(smsHistory)}
    </div>
  </div>`;
}

// ── VEHICLES ──────────────────────────────────────────────────────────────
function renderVehicles() {
  const q = state.searchQuery.toLowerCase();
  const filteredList = q ? state.vehicles.filter(v => (v.registration||'').toLowerCase().includes(q) || (v.vin||'').toLowerCase().includes(q) || (v.make||'').toLowerCase().includes(q) || (v.model||'').toLowerCase().includes(q) || (v.client_name||'').toLowerCase().includes(q)) : state.vehicles;
  const list = sortRows(filteredList, 'vehicles', {
    reg: v => v.registration,
    make_model: v => `${v.make || ''} ${v.model || ''}`,
    year: v => v.year || 0,
    mileage: v => v.mileage || 0,
    mot_due: v => v.mot_due,
    service_due: v => v.service_due,
    owner: v => v.client_name,
    active_job: v => {
      const job = state.jobs.find(j => j.vehicle_id === v.id && !['Completed','Cancelled'].includes(j.status));
      return job?.status || '';
    },
  });
  return `
  <div class="search-bar">
    <input id="search-input" type="text" placeholder="Search registration, VIN, make, model, owner..." value="${escHtml(state.searchQuery)}" oninput="state.searchQuery=this.value;renderInPlace()" />
    <button class="btn btn-primary" onclick="showVehicleModal()">+ Add vehicle</button>
  </div>
  <div class="card data-table-card">
    <div class="table-scroll">
    <table class="data-table vehicles-table"><thead><tr>${SortableTh('vehicles','make_model','Vehicle')}${SortableTh('vehicles','owner','Owner')}${SortableTh('vehicles','mileage','Details')}${SortableTh('vehicles','mot_due','MOT due')}${SortableTh('vehicles','service_due','Service due')}${SortableTh('vehicles','active_job','Active job')}<th>Actions</th></tr></thead><tbody>
    ${list.length === 0 ? renderEmptyTableRow(7, 'No vehicles found') : ''}
    ${list.map(v => {
      const job = state.jobs.find(j => j.vehicle_id === v.id && !['Completed','Cancelled'].includes(j.status));
      const motSoon = v.mot_due && new Date(v.mot_due) < new Date(Date.now()+30*24*60*60*1000);
      return `<tr class="clickable" onclick="showVehicleModal(${v.id})">
        <td>${renderVehicleStack({ make: v.make, model: v.model, registration: v.registration, meta: v.year ? String(v.year) : '' })}</td>
        <td>${renderEntityCell({ label: v.client_name || 'No owner', meta: v.vin ? `VIN ${v.vin}` : '', avatarKey: v.client_id || v.client_name || v.registration })}</td>
        <td><div class="contact-stack">${renderIconMeta('car', fmtDistanceValue(v.mileage), 'No mileage')}${renderIconMeta('wrench', [v.engine, v.fuel_type].filter(Boolean).join(' / '), 'No engine details')}</div></td>
        <td><div class="date-cell">${renderIconMeta('calendar', fmtDate(v.mot_due), 'No MOT date')}${motSoon ? '<div class="entity-subtitle text-red">Due soon</div>' : ''}</div></td>
        <td><div class="date-cell">${renderIconMeta('calendar', fmtDate(v.service_due), 'No service date')}</div></td>
        <td>${job ? statusBadge(job.status) : renderPill('No active job', 'gray')}</td>
        <td>${renderRowActions(v.client_id ? `openClient(${v.client_id})` : `showVehicleModal(${v.id})`, `showVehicleModal(${v.id})`)}</td>
      </tr>`;
    }).join('')}
    </tbody></table>
    </div>
    ${renderTableFooter(list.length, 'vehicles', filteredList.length)}
  </div>`;
}
function setJobStatusFilter(filter) {
  state.jobStatusFilter = normalizeJobStatusFilter(filter);
  renderInPlace();
}

function getJobsForStatusFilter(filter = state.jobStatusFilter, jobs = state.jobs) {
  const normalized = normalizeJobStatusFilter(filter);
  if (normalized === 'completed') return jobs.filter(isCompletedJob);
  if (normalized === 'all') return jobs;
  return jobs.filter(job => !isCompletedJob(job));
}

function renderJobStatusFilterControls(activeFilter, counts) {
  const filters = [
    { key: 'active', label: 'Active', count: counts.active },
    { key: 'completed', label: 'Completed', count: counts.completed },
    { key: 'all', label: 'All', count: counts.all },
  ];
  return `
    <div class="dashboard-filter job-status-filter" role="group" aria-label="Job status filter">
      ${filters.map(filter => `<button class="dashboard-filter-btn ${activeFilter === filter.key ? 'active' : ''}" aria-pressed="${activeFilter === filter.key ? 'true' : 'false'}" onclick="setJobStatusFilter('${filter.key}')">${filter.label} (${filter.count})</button>`).join('')}
    </div>
  `;
}

function renderJobs() {
  const activeFilter = normalizeJobStatusFilter(state.jobStatusFilter);
  const counts = {
    active: getJobsForStatusFilter('active').length,
    completed: getJobsForStatusFilter('completed').length,
    all: state.jobs.length,
  };
  const q = state.searchQuery.toLowerCase();
  const filteredJobs = getJobsForStatusFilter(activeFilter);
  const filteredList = q ? filteredJobs.filter(j => String(j.id).includes(q) || (j.registration||'').toLowerCase().includes(q) || (j.client_name||'').toLowerCase().includes(q) || (j.status||'').toLowerCase().includes(q) || (j.make||'').toLowerCase().includes(q) || (j.model||'').toLowerCase().includes(q)) : filteredJobs;
  const list = sortRows(filteredList, 'jobs', {
    job: j => j.id,
    client: j => j.client_name,
    vehicle: j => `${j.registration || ''} ${j.make || ''} ${j.model || ''}`,
    source: j => j.booking_id ? `${j.booking_date || ''} ${j.booking_time || ''}` : 'Direct',
    status: j => j.status,
    opened: j => j.date_opened,
    total: j => j.subtotal || 0,
  });
  return `
  <div class="search-bar job-search-bar">
    <input id="search-input" type="text" placeholder="Search job #, reg, customer, status..." value="${escHtml(state.searchQuery)}" oninput="state.searchQuery=this.value;renderInPlace()" />
    ${renderJobStatusFilterControls(activeFilter, counts)}
    <button class="btn btn-primary" onclick="showJobModal()">+ New job</button>
  </div>
  <div class="card data-table-card">
    <div class="table-scroll">
    <table class="data-table jobs-table"><thead><tr>${SortableTh('jobs','job','Job')}${SortableTh('jobs','client','Customer')}${SortableTh('jobs','vehicle','Vehicle')}${SortableTh('jobs','source','Source')}${SortableTh('jobs','status','Status')}${SortableTh('jobs','opened','Opened')}${SortableTh('jobs','total','Total')}<th>Actions</th></tr></thead><tbody>
    ${list.length === 0 ? renderEmptyTableRow(8, q ? 'No jobs match this search' : 'No jobs in this view') : ''}
    ${list.map(j=>`
    <tr class="clickable" onclick="openJob(${j.id})">
      <td>${renderEntityCell({ label: `#${j.id}`, meta: (j.complaint || 'Workshop job').slice(0, 52), avatarKey: `job-${j.id}` })}</td>
      <td>${renderEntityCell({ label: j.client_name || 'Customer', meta: j.mechanic ? `Mechanic: ${j.mechanic}` : 'Unassigned', avatarKey: j.client_id || j.client_name })}</td>
      <td>${renderVehicleStack({ make: j.make, model: j.model, registration: j.registration })}</td>
      <td><div class="contact-stack">${j.booking_id ? renderIconMeta('calendar', `Booking ${fmtDate(j.booking_date)} ${j.booking_time || ''}`.trim()) : renderIconMeta('wrench', 'Direct job')}</div></td>
      <td>${statusBadge(j.status)}</td>
      <td>${renderDateCell(j.date_opened, 'No opened date')}</td>
      <td><strong>${fmt(j.subtotal)}</strong></td>
      <td>${renderRowActions(`openJob(${j.id})`, `showJobModal(${j.id})`)}</td>
    </tr>`).join('')}
    </tbody></table>
    </div>
    ${renderTableFooter(list.length, 'jobs', filteredList.length)}
  </div>`;
}
async function renderJobCard() {
  const job = state.jobs.find(j => j.id === state.selectedJob);
  if (!job) return '<p>Job not found</p>';
  state.jobLines = await invoke('get_job_lines', { jobId: job.id });
  mergeAllJobLinesForJob(job.id, state.jobLines);
  const subtotal = state.jobLines.reduce((s,l) => s + l.qty * l.unit_price, 0);
  const vatRate = getAppliedVatRate();
  const vat = getVatAmount(subtotal, vatRate);
  const total = subtotal + vat;
  const inv = state.invoices.find(i => i.job_id === job.id);
  const client = state.clients.find(c => c.id === job.client_id);
  const vehicle = state.vehicles.find(v => v.id === job.vehicle_id);
  return renderJobProfileLayout({ job, client, vehicle, inv, subtotal, vatRate, vat, total });
  if (false) return `
  <button class="btn back-btn" onclick="backToJobs()">← Back to jobs</button>
  <div class="two-col">
    <div>
      <div class="card">
        <div class="flex gap-8" style="justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:12px">
          <div><div style="font-size:11px;color:var(--text2)">JOB #${job.id}</div>
          <div style="font-size:16px;font-weight:500">${escHtml(job.registration)} — ${escHtml(job.make)} ${escHtml(job.model)}</div>
          <div class="text-sm text-muted">${escHtml(job.client_name)} · Opened ${fmtDate(job.date_opened)}</div></div>
          <div style="text-align:right">
            <select onchange="updateJobStatus(${job.id},this.value)" style="font-size:12px;padding:4px 8px;border:0.5px solid var(--border2);border-radius:6px;background:var(--surface);color:var(--text)">
              ${['New','Diagnosing','Waiting Parts','In Progress','Ready','Completed','Cancelled'].map(s=>`<option value="${s}" ${job.status===s?'selected':''}>${s}</option>`).join('')}
            </select>
            <div class="text-sm text-muted" style="margin-top:4px">Mechanic: ${escHtml(job.mechanic||'Unassigned')}</div>
          </div>
        </div>
        <div class="form-grid" style="margin-bottom:12px">
          <div class="form-row"><label>Customer complaint</label><textarea rows="3" onblur="saveJobField(${job.id},'complaint',this.value)">${escHtml(job.complaint||'')}</textarea></div>
          <div class="form-row"><label>Findings / diagnostics</label><textarea rows="3" onblur="saveJobField(${job.id},'findings',this.value)">${escHtml(job.findings||'')}</textarea></div>
          <div class="form-row"><label>Work performed</label><textarea rows="2" onblur="saveJobField(${job.id},'work_performed',this.value)">${escHtml(job.work_performed||'')}</textarea></div>
          <div class="form-row"><label>Mechanic</label><input type="text" value="${escHtml(job.mechanic||'')}" onblur="saveJobField(${job.id},'mechanic',this.value)" /></div>
          <div class="form-row"><label>${getDistanceInLabel()}</label><input type="number" value="${getSyncedJobMileage(job, vehicle)}" onblur="saveJobFieldNum(${job.id},'mileage_in',this.value)" /></div>
          <div class="form-row"><label>Est. completion</label><input type="date" value="${job.est_completion||''}" onblur="saveJobField(${job.id},'est_completion',this.value)" /></div>
        </div>
        <div class="form-row"><label>Customer notes</label><textarea rows="2" onblur="saveJobField(${job.id},'customer_notes',this.value)">${escHtml(job.customer_notes||'')}</textarea></div>
        <div class="form-row"><label>Internal notes</label><textarea rows="2" onblur="saveJobField(${job.id},'internal_notes',this.value)">${escHtml(job.internal_notes||'')}</textarea></div>
      </div>

      <div class="card">
        <div class="card-header"><span class="card-title">Labour &amp; Parts</span><button class="btn btn-sm btn-primary" onclick="addJobLine(${job.id})">+ Add line</button></div>
        <table class="line-table">
          <thead><tr><th>Type</th><th>Description</th><th>Qty</th><th>Unit price</th><th>Total</th><th class="line-table-status-head"></th><th class="line-table-action-head"></th></tr></thead>
          <tbody id="job-lines-body">
          ${state.jobLines.map(l=>`
          <tr class="${isLinePending(l) ? 'line-row-pending' : ''}" data-line-id="${l.id}">
            <td><select id="job-line-${l.id}-line_type" onchange="updateLine(${l.id},'line_type',this.value)">${renderLineTypeOptions(l.line_type)}</select></td>
            <td><input id="job-line-${l.id}-description" type="text" value="${escHtml(l.description||'')}" onblur="updateLine(${l.id},'description',this.value)" /></td>
            <td style="width:60px"><input id="job-line-${l.id}-qty" type="number" value="${l.qty}" step="0.5" min="0" onblur="updateLineNum(${l.id},'qty',this.value)" /></td>
            <td style="width:90px"><input id="job-line-${l.id}-unit_price" type="number" value="${l.unit_price}" step="0.01" min="0" onfocus="clearZeroNumberInput(this)" onblur="updateLineNum(${l.id},'unit_price',this.value)" onkeydown="handleJobLineUnitPriceEnter(event,${job.id},${l.id})" /></td>
            <td style="width:80px">${fmt(l.qty * l.unit_price)}</td>
            <td id="job-line-${l.id}-status-cell" class="line-status-cell">${renderLineStatusToggle(l)}</td>
            <td><button class="btn btn-sm btn-danger" onclick="deleteLine(${l.id})">✕</button></td>
          </tr>`).join('')}
          </tbody>
        </table>
        <div class="totals-box">
          <div class="total-row"><span class="text-muted">Subtotal</span><span>${fmt(subtotal)}</span></div>
          <div class="total-row"><span class="text-muted">${getVatLabel(vatRate)}</span><span>${fmt(vat)}</span></div>
          <div class="total-row grand"><span>Total</span><span>${fmt(total)}</span></div>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          ${inv ? `<button class="btn btn-primary" onclick="selectInvoice(${inv.id})">View Invoice ${escHtml(inv.invoice_number)}</button>` : `<button class="btn btn-primary" onclick="genInvoice(${job.id})">Generate Invoice</button>`}
          <button class="btn" onclick="updateJobStatus(${job.id},'Ready')">Mark Ready</button>
          <button class="btn" onclick="markJobReadyAndSendSms(${job.id})">Mark Ready &amp; Send SMS</button>
          <button class="btn" onclick="updateJobStatus(${job.id},'Completed')">Mark Complete</button>
        </div>
      </div>
    </div>

    <div>
      <div class="card">
        <div class="card-title" style="margin-bottom:10px">Customer</div>
        ${client ? `<div class="flex gap-8"><div class="avatar">${initials(client.name)}</div><div><div style="font-weight:500">${escHtml(client.name)}</div><div class="text-sm text-muted">${escHtml(client.phone||'')} · ${escHtml(client.email||'')}</div></div></div>` : ''}
      </div>
      <div class="card">
        <div class="vehicle-card-header">
          <div class="card-title">Vehicle</div>
          ${renderVehicleVinInline(vehicle)}
        </div>
        ${vehicle ? `
        <div class="detail-grid">
          <div class="detail-item"><div class="dl">Registration</div><div class="dv" style="font-weight:600">${escHtml(vehicle.registration)}</div></div>
          <div class="detail-item"><div class="dl">Make / Model</div><div class="dv">${escHtml(vehicle.make)} ${escHtml(vehicle.model)}</div></div>
          <div class="detail-item"><div class="dl">Year</div><div class="dv">${vehicle.year||'—'}</div></div>
          <div class="detail-item"><div class="dl">Engine</div><div class="dv">${escHtml(vehicle.engine||'—')}</div></div>
          <div class="detail-item"><div class="dl">Fuel</div><div class="dv">${escHtml(vehicle.fuel_type||'—')}</div></div>
          <div class="detail-item"><div class="dl">Colour</div><div class="dv">${escHtml(vehicle.colour||'—')}</div></div>
          <div class="detail-item"><div class="dl">${getDistanceInLabel()}</div><div class="dv">${fmtDistanceValue(getSyncedJobMileage(job, vehicle))}</div></div>
          <div class="detail-item"><div class="dl">MOT due</div><div class="dv">${fmtDate(vehicle.mot_due)}</div></div>
        </div>` : ''}
      </div>
      ${inv ? `
      <div class="card">
        <div class="card-header"><span class="card-title">Invoice</span>${statusBadge(inv.status)}</div>
        <div class="detail-grid">
          <div class="detail-item"><div class="dl">Number</div><div class="dv">${escHtml(inv.invoice_number)}</div></div>
          <div class="detail-item"><div class="dl">Issued</div><div class="dv">${fmtDate(inv.date_issued)}</div></div>
          <div class="detail-item"><div class="dl">Due</div><div class="dv">${fmtDate(inv.due_date)}</div></div>
          <div class="detail-item"><div class="dl">Total</div><div class="dv" style="font-weight:500">${fmt(inv.total)}</div></div>
        </div>
        ${inv.status==='Unpaid'?`<button class="btn btn-primary btn-sm" style="margin-top:10px" onclick="markPaid(${inv.id})">Mark as paid</button>`:''}
      </div>` : ''}
    </div>
  </div>`;
}

// ── INVOICES ──────────────────────────────────────────────────────────────
async function renderInvoices() {
  const q = state.searchQuery.toLowerCase();
  const filteredList = q ? state.invoices.filter(i => (i.invoice_number||'').toLowerCase().includes(q) || (i.client_name||'').toLowerCase().includes(q) || (i.status||'').toLowerCase().includes(q) || (i.registration||'').toLowerCase().includes(q) || (i.make||'').toLowerCase().includes(q) || (i.model||'').toLowerCase().includes(q)) : state.invoices;
  const list = sortRows(filteredList, 'invoices', {
    number: i => i.invoice_number,
    client: i => i.client_name,
    vehicle: i => `${i.registration || ''} ${i.make || ''} ${i.model || ''}`,
    total: i => i.total || 0,
    status: i => i.status,
    due: i => i.due_date,
  });
  const outstanding = state.invoices.reduce((sum, invoice) => sum + getInvoiceBalanceDue(invoice, getInvoiceTotalAmount(invoice)), 0);
  const collected = state.invoices.reduce((sum, invoice) => sum + getInvoicePaidAmount(invoice, getInvoiceTotalAmount(invoice)), 0);
  return `
  <div class="search-bar">
    <input id="search-input" type="text" placeholder="Search invoice #, customer, reg, status..." value="${escHtml(state.searchQuery)}" oninput="state.searchQuery=this.value;renderInPlace()" />
  </div>
  <div class="card data-table-card">
    <div class="table-scroll">
    <table class="data-table invoices-table"><thead><tr>${SortableTh('invoices','number','Invoice')}${SortableTh('invoices','client','Customer')}${SortableTh('invoices','vehicle','Vehicle')}${SortableTh('invoices','total','Total')}${SortableTh('invoices','status','Status')}${SortableTh('invoices','due','Due')}${'<th>Actions</th>'}</tr></thead><tbody>
      ${list.length === 0 ? renderEmptyTableRow(7, 'No invoices yet') : ''}
      ${list.map(i=>{
        const invoiceTotal = getInvoiceTotalAmount(i);
        const paidAmount = getInvoicePaidAmount(i, invoiceTotal);
        const balanceDue = getInvoiceBalanceDue(i, invoiceTotal);
        const duePast = balanceDue > 0 && i.due_date && new Date(`${i.due_date}T23:59:59`) < new Date();
        const displayStatus = balanceDue <= 0 ? 'Paid' : (paidAmount > 0 ? 'Partial' : i.status);
        const amountMeta = paidAmount > 0 && balanceDue > 0
          ? `<div class="entity-subtitle">Paid ${fmt(paidAmount)} · Due ${fmt(balanceDue)}</div>`
          : (paidAmount > 0 ? '<div class="entity-subtitle">Paid in full</div>' : '');
        return `<tr class="clickable" onclick="selectInvoice(${i.id})">
          <td>${renderEntityCell({ label: i.invoice_number || `Invoice ${i.id}`, meta: i.date_issued ? `Issued ${fmtDate(i.date_issued)}` : '', avatarKey: `invoice-${i.id}` })}</td>
          <td>${renderEntityCell({ label: i.client_name || 'Customer', meta: i.job_id ? `Job #${i.job_id}` : '', avatarKey: i.client_name || i.id })}</td>
          <td>${renderVehicleStack({ make: i.make, model: i.model, registration: i.registration })}</td>
          <td><strong>${fmt(invoiceTotal)}</strong>${amountMeta}</td>
          <td>${duePast ? renderPill(`Overdue ${fmt(balanceDue)}`, 'red') : statusBadge(displayStatus)}</td>
          <td>${renderDateCell(i.due_date, 'No due date')}</td>
          <td>${renderRowActions(`selectInvoice(${i.id})`, `printInvoice(${i.id})`)}</td>
        </tr>`;
      }).join('')}
    </tbody></table>
    </div>
    <div class="table-summary-strip">
      <span>Outstanding <strong class="text-red">${fmt(outstanding)}</strong></span>
      <span>Total collected <strong>${fmt(collected)}</strong></span>
    </div>
    ${renderTableFooter(list.length, 'invoices', filteredList.length)}
  </div>`;
}
function renderInvoiceEditor(inv) {
  if (!inv) return '';
  const lines = state.invoiceLines;
  const { subtotal, vatRate, vat, total, paidAmount, balanceDue, lineBreakdown } = calculateInvoiceDraftTotals(inv, lines);
  const showVat = shouldShowInvoiceVat();
  const syncMeta = getInvoiceEditorSyncMeta();
  const showPaymentRows = shouldShowInvoicePaymentRows(inv, paidAmount);
  const isPartial = normalizeInvoiceStatusValue(inv.status) === 'Partial';
  return `
  <div class="modal modal-wide">
    <h2>Edit Invoice</h2>
    <div class="invoice-preview print-target">
    <div class="card-header" style="margin-bottom:12px;align-items:flex-start">
      <div>
        <span class="card-title">Edit Invoice</span>
        <div class="text-sm text-muted print-hide" id="invoice-editor-save-note" style="margin-top:6px">${escHtml(syncMeta.note)}</div>
      </div>
    </div>
    <div class="form-grid" style="margin-bottom:12px">
      <div class="form-row"><label>Invoice #</label><input id="invoice-${inv.id}-number" type="text" value="${escHtml(inv.invoice_number || '')}" onblur="saveInvoiceField(${inv.id},'invoice_number',this.value)" /></div>
      <div class="form-row"><label>Issued</label><input id="invoice-${inv.id}-issued" type="date" value="${inv.date_issued || ''}" onchange="saveInvoiceField(${inv.id},'date_issued',this.value)" /></div>
      <div class="form-row"><label>Due</label><input id="invoice-${inv.id}-due" type="date" value="${inv.due_date || ''}" onchange="saveInvoiceField(${inv.id},'due_date',this.value)" /></div>
      <div class="form-row"><label>Status</label>
        <select id="invoice-${inv.id}-status" onchange="handleInvoiceStatusChange(${inv.id},this.value)">
          ${['Unpaid','Partial','Paid'].map(status => `<option ${normalizeInvoiceStatusValue(inv.status)===status?'selected':''}>${status}</option>`).join('')}
        </select>
      </div>
      ${isPartial ? `<div class="form-row"><label>Deposit / amount paid</label><input id="invoice-${inv.id}-paid-amount" type="number" value="${paidAmount ? paidAmount.toFixed(2) : ''}" min="0" max="${total.toFixed(2)}" step="0.01" placeholder="0.00" oninput="previewInvoicePaidAmount(${inv.id},this.value)" onblur="saveInvoicePaidAmount(${inv.id},this.value)" /></div>` : ''}
      <div class="form-row"><label>Payment method</label><input id="invoice-${inv.id}-payment-method" type="text" value="${escHtml(inv.payment_method || '')}" onblur="saveInvoiceField(${inv.id},'payment_method',this.value)" placeholder="Cash, Card, Bank transfer…" /></div>
      ${showVat ? `<div class="form-row"><label>VAT rate (%)</label><input id="invoice-${inv.id}-vat-rate" type="text" value="${formatVatRate(vatRate)}" readonly /></div>` : ''}
    </div>
    <div class="form-row"><label>Notes</label><textarea id="invoice-${inv.id}-notes" rows="3" onblur="saveInvoiceField(${inv.id},'notes',this.value)">${escHtml(inv.notes || '')}</textarea></div>
    <div style="background:var(--surface2);border-radius:var(--radius);padding:10px 12px;margin:14px 0">
      <div style="font-weight:500">${escHtml(inv.client_name)}</div>
      <div class="text-sm text-muted">${escHtml(inv.registration)} · ${escHtml(inv.make)} ${escHtml(inv.model)}</div>
    </div>
    <div class="card-header line-editor-head" style="margin:14px 0 8px">
      <span class="card-title">Line items</span>
      <button class="btn btn-sm btn-primary" onclick="addInvoiceLine(${inv.job_id})">+ Add line</button>
    </div>
    ${renderEditableLineEditor(lines, inv.job_id)}
    <template>
      <thead><tr><th>Type</th><th>Inventory</th><th>Description</th><th>Qty</th><th>Unit price</th><th>Total</th><th class="line-table-status-head print-hide"></th><th class="line-table-action-head print-hide"><button class="btn btn-sm btn-primary" onclick="addInvoiceLine(${inv.job_id})">+ Add line</button></th></tr></thead>
      <tbody>
      ${lines.length === 0 ? '<tr><td colspan="8" class="text-sm text-muted" style="padding:16px 0;text-align:center">No labour or parts lines yet</td></tr>' : lines.map(l => `
      <tr class="${isLinePending(l) ? 'line-row-pending' : ''}" data-line-id="${l.id}">
        <td>${renderLineTypeControl(l)}</td>
        <td>${renderInventoryLineSelect(l)}</td>
        <td><input id="job-line-${l.id}-description" type="text" value="${escHtml(l.description || '')}" onblur="updateLine(${l.id},'description',this.value)" />${renderLineInventorySummary(l)}</td>
        <td style="width:60px"><input id="job-line-${l.id}-qty" type="number" value="${l.qty}" step="0.5" min="0" oninput="previewLineNumberInput(${l.id})" onblur="updateLineNum(${l.id},'qty',this.value)" /></td>
        <td style="width:90px"><input id="job-line-${l.id}-unit_price" type="number" value="${l.unit_price}" step="0.01" min="0" onfocus="clearZeroNumberInput(this)" oninput="previewLineNumberInput(${l.id})" onblur="updateLineNum(${l.id},'unit_price',this.value)" onkeydown="handleJobLineUnitPriceEnter(event,${inv.job_id},${l.id})" /></td>
        <td id="job-line-${l.id}-total" style="width:80px">${fmt((l.qty || 0) * (l.unit_price || 0))}</td>
        <td id="job-line-${l.id}-status-cell" class="line-status-cell print-hide">${renderLineStatusToggle(l)}</td>
        <td><button class="btn btn-sm btn-danger" onclick="deleteLine(${l.id})">✕</button></td>
      </tr>`).join('')}
      </tbody>
    </template>
    <div class="totals-box">
      <div class="total-row"><span class="text-muted">Subtotal</span><span id="invoice-editor-subtotal">${fmt(subtotal)}</span></div>
      ${showVat ? `<div class="total-row"><span class="text-muted" id="invoice-editor-vat-label">${getVatLabel(vatRate)}</span><span id="invoice-editor-vat">${fmt(vat)}</span></div>` : ''}
      <div class="total-row grand"><span>Total</span><span id="invoice-editor-total">${fmt(total)}</span></div>
      ${showPaymentRows ? `<div class="total-row"><span class="text-muted">Deposit paid</span><span id="invoice-editor-paid-amount">${fmt(paidAmount)}</span></div>
      <div class="total-row grand"><span>Balance due</span><span id="invoice-editor-balance-due">${fmt(balanceDue)}</span></div>` : ''}
      <div class="garage-line-breakdown">
        <div class="garage-line-breakdown-title">Garage breakdown</div>
        <div class="total-row garage-line-breakdown-row"><span>Labour</span><span id="invoice-editor-labour-total">${fmt(lineBreakdown.labour)}</span></div>
        <div class="total-row garage-line-breakdown-row"><span>Parts</span><span id="invoice-editor-parts-total">${fmt(lineBreakdown.parts)}</span></div>
        <div class="total-row garage-line-breakdown-row"><span>Other</span><span id="invoice-editor-other-total">${fmt(lineBreakdown.other)}</span></div>
      </div>
    </div>
    <div style="margin-top:14px;font-size:11px;color:var(--text2)">Garage name, currency, distance unit and VAT settings come from Settings.</div>
    </div>
    <div class="modal-footer invoice-editor-footer">
      <div class="invoice-editor-footer-actions">
        <button class="btn" onclick="closeModal()">Close</button>
        <button class="btn" onclick="closeModal(false);openJob(${inv.job_id})">Open Job</button>
      </div>
      <div class="invoice-editor-footer-actions print-hide">
        <button id="invoice-editor-save-cloud-btn" class="btn ${syncMeta.primary ? 'btn-primary' : ''}" onclick="saveInvoiceEditorToCloud()" ${syncMeta.disabled ? 'disabled' : ''}>${syncMeta.buttonLabel}</button>
        <button class="btn" onclick="printInvoice(${inv.id})">Print</button>
        ${balanceDue > 0 ? `<button class="btn" onclick="markPaid(${inv.id})">Mark as Paid</button>` : ''}
      </div>
    </div>
  </div>`;
}

function getInvoiceById(invoiceId) {
  return state.invoices.find(i => i.id === invoiceId) || null;
}

async function showInvoiceEditor(invoiceId) {
  const inv = getInvoiceById(invoiceId);
  if (!inv) {
    alert('Invoice not found');
    return;
  }
  state.selectedInvoice = invoiceId;
  state.invoiceEditorId = invoiceId;
  state.invoiceEditorScrollTop = 0;
  state.invoiceLines = await invoke('get_job_lines', { jobId: inv.job_id });
  applyInvoiceDraftTotals(invoiceId);
  showModal(renderInvoiceEditor(inv));
  updateInvoiceEditorSaveUi();
  applyPendingFocus();
}

async function refreshInvoiceEditorModal({ reloadLines = false } = {}) {
  if (!state.invoiceEditorId || !document.getElementById('modal-overlay')) return;
  const overlay = document.getElementById('modal-overlay');
  const activeSnapshot = snapshotActiveField(overlay);
  const currentModal = document.querySelector('#modal-overlay .modal');
  state.invoiceEditorScrollTop = currentModal?.scrollTop || 0;
  const inv = getInvoiceById(state.invoiceEditorId);
  if (!inv) {
    closeModal();
    return;
  }
  if (reloadLines) {
    state.invoiceLines = await invoke('get_job_lines', { jobId: inv.job_id });
  }
  applyInvoiceDraftTotals(inv.id);
  showModal(renderInvoiceEditor(inv));
  const nextModal = document.querySelector('#modal-overlay .modal');
  if (nextModal && !state.pendingFocusId) {
    nextModal.scrollTop = state.invoiceEditorScrollTop;
  }
  if (!state.pendingFocusId) {
    restoreActiveField(activeSnapshot);
  }
  updateInvoiceEditorSaveUi();
  applyPendingFocus();
}

async function refreshInvoicesState() {
  state.invoices = await invoke('get_invoices');
  if (state.invoiceEditorId === null) return null;
  const inv = getInvoiceById(state.invoiceEditorId);
  if (!inv) {
    state.invoiceLines = [];
    return null;
  }
  state.invoiceLines = await invoke('get_job_lines', { jobId: inv.job_id });
  return inv;
}

function ensurePrintRoot() {
  let root = document.getElementById('print-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'print-root';
    root.className = 'print-root';
    document.body.appendChild(root);
  }
  return root;
}

function renderInvoicePrintDocument(inv) {
  if (!inv) return '';
  const lines = state.invoiceLines || [];
  const notes = (inv.notes || '').trim();
  const settings = getSettings();
  const vatRate = getAppliedVatRate();
  const showVat = shouldShowInvoiceVat();
  const totals = calculateInvoiceDraftTotals(inv, lines);
  const showPaymentRows = shouldShowInvoicePaymentRows(inv, totals.paidAmount);
  const businessLines = [
    ...getGarageAddressLines(),
    settings.garage_phone ? `Tel: ${settings.garage_phone}` : '',
    settings.garage_email ? `Email: ${settings.garage_email}` : '',
    settings.garage_website ? settings.garage_website : '',
    settings.company_number ? `Company No: ${settings.company_number}` : '',
    settings.vat_number ? `VAT No: ${settings.vat_number}` : '',
  ].filter(Boolean);
  const invoiceNoteLines = [notes, settings.payment_terms, settings.bank_details]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  return `
  <div class="invoice-print-shell">
    <div class="print-preview-toolbar">
      <button class="btn" onclick="clearPrintMode()">Back to app</button>
      <button class="btn btn-primary" onclick="printInvoice(${inv.id})">Print again</button>
    </div>
    <article class="invoice-sheet">
      <header class="invoice-sheet-head">
        <div>
          <div class="invoice-sheet-eyebrow">${escHtml(getGarageName())}</div>
          <h1 class="invoice-sheet-title">Invoice</h1>
          <div class="invoice-sheet-subtitle">${escHtml(normalizeCurrency(settings.currency))} billing · ${escHtml(getDistanceLabelWithUnit())}</div>
          ${businessLines.length ? `<div class="invoice-sheet-muted" style="margin-top:10px;max-width:360px">${businessLines.map(escHtml).join('<br>')}</div>` : ''}
        </div>
        <div class="invoice-sheet-meta">
          <div class="invoice-meta-row"><span>Invoice #</span><strong>${escHtml(inv.invoice_number)}</strong></div>
          <div class="invoice-meta-row"><span>Issued</span><strong>${fmtDate(inv.date_issued)}</strong></div>
          <div class="invoice-meta-row"><span>Due</span><strong>${fmtDate(inv.due_date)}</strong></div>
          <div class="invoice-meta-row"><span>Status</span><strong>${escHtml(inv.status)}</strong></div>
        </div>
      </header>

      <section class="invoice-sheet-grid">
        <div class="invoice-sheet-card">
          <div class="invoice-sheet-label">Bill To</div>
          <div class="invoice-sheet-value">${escHtml(inv.client_name || 'Walk-in customer')}</div>
        </div>
        <div class="invoice-sheet-card">
          <div class="invoice-sheet-label">Vehicle</div>
          <div class="invoice-sheet-value">${escHtml(inv.registration || '—')}</div>
          <div class="invoice-sheet-muted">${escHtml([inv.make, inv.model].filter(Boolean).join(' ') || 'Vehicle details not available')}</div>
        </div>
        <div class="invoice-sheet-card">
          <div class="invoice-sheet-label">Payment</div>
          <div class="invoice-sheet-value">${escHtml(inv.payment_method || 'Not recorded')}</div>
          ${showVat ? `<div class="invoice-sheet-muted">${escHtml(getVatLabel(vatRate))}</div>` : ''}
        </div>
      </section>

      <section class="invoice-sheet-lines">
        <table class="invoice-sheet-table">
          <thead>
            <tr>
              <th>Description</th>
              <th>Type</th>
              <th class="text-right">Qty</th>
              <th class="text-right">Unit</th>
              <th class="text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${lines.length === 0 ? `
            <tr>
              <td colspan="5" class="invoice-sheet-empty">No labour or parts lines added</td>
            </tr>` : lines.map(line => `
            <tr>
              <td>${renderPrintLineDescription(line)}</td>
              <td>${escHtml(line.line_type || '—')}</td>
              <td class="text-right">${fmtQty(line.qty)}</td>
              <td class="text-right">${fmt(line.unit_price)}</td>
              <td class="text-right">${fmt((line.qty || 0) * (line.unit_price || 0))}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </section>

      <section class="invoice-sheet-footer">
        <div class="invoice-sheet-note">
          <div class="invoice-sheet-label">Notes</div>
          <div class="invoice-sheet-muted">${invoiceNoteLines.length ? invoiceNoteLines.map(escHtml).join('<br><br>') : 'No notes recorded.'}</div>
        </div>
        <div class="invoice-sheet-totals">
          <div class="invoice-sheet-total-row"><span>Subtotal</span><strong>${fmt(totals.subtotal)}</strong></div>
          ${showVat ? `<div class="invoice-sheet-total-row"><span>${getVatLabel(vatRate)}</span><strong>${fmt(totals.vat)}</strong></div>` : ''}
          <div class="invoice-sheet-total-row grand"><span>Total</span><strong>${fmt(totals.total)}</strong></div>
          ${showPaymentRows ? `<div class="invoice-sheet-total-row"><span>Deposit paid</span><strong>${fmt(totals.paidAmount)}</strong></div>
          <div class="invoice-sheet-total-row grand"><span>Balance due</span><strong>${fmt(totals.balanceDue)}</strong></div>` : ''}
        </div>
      </section>
    </article>
  </div>`;
}

function mountPrintInvoice(inv) {
  const root = ensurePrintRoot();
  root.innerHTML = renderInvoicePrintDocument(inv);
}

function enterPrintMode(inv) {
  mountPrintInvoice(inv);
  document.body.classList.add('print-invoice-mode');
  document.getElementById('app').classList.add('app-hidden-for-print');
  ensurePrintRoot().classList.add('print-root-active');
}

function leavePrintMode() {
  document.body.classList.remove('print-invoice-mode');
  document.getElementById('app').classList.remove('app-hidden-for-print');
  const root = document.getElementById('print-root');
  if (root) {
    root.classList.remove('print-root-active');
    root.innerHTML = '';
  }
}

// ── CALENDAR ──────────────────────────────────────────────────────────────
function getSettingsCategoryBadge(category) {
  if (category === 'garage') return normalizeCurrency(getSettings().currency);
  if (category === 'booking') return `${getBookingSlotInterval()} min`;
  if (category === 'inventory') return isInventoryEnabled() ? 'On' : 'Off';
  if (category === 'messages') return getMessageSettings().sms_enabled && isMessagingConfigured() ? 'On' : getSmsProviderStatusLabel();
  if (category === 'billing') {
    const snapshot = state.billingSnapshot;
    if (isBillingAdminAccount(snapshot)) return 'Admin';
    return snapshot?.garage?.plan ? getBillingPlanMeta(snapshot.garage.plan).title : 'Plans';
  }
  if (category === 'account') return isCloudSignedIn() ? 'Signed in' : 'Login';
  if (category === 'system') {
    const appUpdate = getAppUpdateState();
    return appUpdate.configured ? (appUpdate.availableVersion ? 'Update' : 'Ready') : 'Setup';
  }
  return '';
}

function renderSettingsSubmenu(activeCategory) {
  return `
    <aside class="settings-submenu" aria-label="Settings categories">
      <div class="settings-submenu-list">
        ${SETTINGS_CATEGORIES.map(category => {
          const active = category.key === activeCategory;
          return `
            <button
              type="button"
              class="settings-submenu-item ${active ? 'active' : ''}"
              aria-pressed="${active ? 'true' : 'false'}"
              onclick="setSettingsCategory('${category.key}')"
            >
              <span class="settings-submenu-copy">
                <span class="settings-submenu-label">${escHtml(category.label)}</span>
                ${category.detail ? `<span class="settings-submenu-detail">${escHtml(category.detail)}</span>` : ''}
              </span>
              <span class="settings-submenu-badge">${escHtml(getSettingsCategoryBadge(category.key))}</span>
            </button>
          `;
        }).join('')}
      </div>
    </aside>
  `;
}

function renderGarageSettingsCard() {
  const settings = getSettings();
  const currency = normalizeCurrency(settings.currency);
  const language = getAppLanguage();
  const distanceUnit = getDistanceUnit();
  const vatEnabled = isVatEnabled();
  const vatRate = getDefaultVatRate();
  const signedIn = isCloudSignedIn();
  const setupMode = Boolean(state.garageSetupMode);
  return `
    <div class="card settings-card">
      <div class="settings-card-head">
        <div>
          <div class="settings-kicker">Workspace</div>
          <div class="settings-title">${setupMode ? 'Garage setup' : 'Garage'}</div>
        </div>
        <span class="badge ${signedIn ? 'badge-green' : 'badge-amber'}">${signedIn ? 'Active' : 'Locked'}</span>
      </div>
      <div class="form-row">
        <label>Garage name</label>
        <input id="settings-garage-name" type="text" value="${escHtml(settings.garage_name)}" placeholder="Garage name" />
      </div>
      <div class="form-row">
        <label>Business address</label>
        <textarea id="settings-garage-address" rows="3" placeholder="Street, town, postcode">${escHtml(settings.garage_address || '')}</textarea>
      </div>
      <div class="form-grid">
        <div class="form-row">
          <label>Garage phone</label>
          <input id="settings-garage-phone" type="tel" value="${escHtml(settings.garage_phone || '')}" placeholder="Phone number" />
        </div>
        <div class="form-row">
          <label>Garage email</label>
          <input id="settings-garage-email" type="email" value="${escHtml(settings.garage_email || '')}" placeholder="email@example.com" />
        </div>
      </div>
      <div class="form-grid">
        <div class="form-row">
          <label>Website</label>
          <input id="settings-garage-website" type="text" value="${escHtml(settings.garage_website || '')}" placeholder="https://example.com" />
        </div>
        <div class="form-row">
          <label>Company number</label>
          <input id="settings-company-number" type="text" value="${escHtml(settings.company_number || '')}" placeholder="Optional" />
        </div>
      </div>
      <div class="form-grid">
        <div class="form-row">
          <label>Distance unit</label>
          <select id="settings-distance-unit">
            <option value="mi" ${distanceUnit === 'mi' ? 'selected' : ''}>${uiText('Miles (mi)')}</option>
            <option value="km" ${distanceUnit === 'km' ? 'selected' : ''}>${uiText('Kilometres (km)')}</option>
          </select>
        </div>
        <div class="form-row">
          <label>Language</label>
          <select id="settings-language">
            ${LANGUAGE_OPTIONS.map(option => `<option value="${option.value}" ${language === option.value ? 'selected' : ''}>${escHtml(option.label)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-grid">
        <div class="form-row">
          <label>Currency</label>
          <input id="settings-currency" type="text" value="${escHtml(currency)}" maxlength="3" placeholder="GBP" style="text-transform:uppercase" />
        </div>
      </div>
      <div class="form-grid">
        <div class="form-row">
          <label>VAT</label>
          <select id="settings-vat-enabled">
            <option value="true" ${vatEnabled ? 'selected' : ''}>${uiText('Enabled')}</option>
            <option value="false" ${!vatEnabled ? 'selected' : ''}>${uiText('Disabled')}</option>
          </select>
        </div>
        <div class="form-row">
          <label>Default VAT rate (%)</label>
          <input id="settings-default-vat-rate" type="number" min="0" max="100" step="0.01" value="${escHtml(vatRate)}" />
        </div>
      </div>
      <div class="form-row">
        <label>VAT number</label>
        <input id="settings-vat-number" type="text" value="${escHtml(settings.vat_number || '')}" placeholder="Optional" />
      </div>
      <div class="form-grid">
        <div class="form-row">
          <label>Payment terms</label>
          <textarea id="settings-payment-terms" rows="3" placeholder="Payment due within 7 days">${escHtml(settings.payment_terms || '')}</textarea>
        </div>
        <div class="form-row">
          <label>Bank details</label>
          <textarea id="settings-bank-details" rows="3" placeholder="Bank name, sort code, account number">${escHtml(settings.bank_details || '')}</textarea>
        </div>
      </div>
      <div class="settings-actions">
        <button class="btn btn-primary" onclick="saveSettings()" ${!signedIn ? 'disabled' : ''}>${setupMode ? 'Save and open Dashboard' : 'Save changes'}</button>
        <button class="btn" onclick="render()">Discard</button>
      </div>
    </div>
  `;
}

function renderBookingSettingsCard() {
  const slotInterval = getBookingSlotInterval();
  const allowPastBookingTimes = getAllowPastBookingTimes();
  return `
    <div class="card settings-card">
      <div class="settings-card-head">
        <div>
          <div class="settings-kicker">Calendar</div>
          <div class="settings-title">Bookings</div>
        </div>
        <span class="badge badge-blue">${slotInterval === 30 ? '30 minute slots' : 'Hourly slots'}</span>
      </div>
      <div class="settings-option-list">
        <div class="settings-option-row">
          <div class="settings-option-copy">
            <div class="settings-option-title">Calendar slot size</div>
          </div>
          <select id="settings-booking-slot-interval">
            <option value="60" ${slotInterval === 60 ? 'selected' : ''}>${uiText('1 hour')}</option>
            <option value="30" ${slotInterval === 30 ? 'selected' : ''}>${uiText('30 minutes')}</option>
          </select>
        </div>
        <label class="settings-option-row settings-option-toggle">
          <span class="settings-option-copy">
            <span class="settings-option-title">Allow same-day past times</span>
          </span>
          <input id="settings-allow-past-booking-times" type="checkbox" ${allowPastBookingTimes ? 'checked' : ''} />
        </label>
      </div>
      <div class="settings-actions">
        <button class="btn btn-primary" onclick="saveBookingSettings()">Save booking settings</button>
        <button class="btn" onclick="nav('calendar')">Open calendar</button>
      </div>
    </div>
  `;
}

function renderInventorySettingsCard() {
  const inventoryEnabled = isInventoryEnabled();
  return `
    <div class="card settings-card">
      <div class="settings-card-head">
        <div>
          <div class="settings-kicker">Stock</div>
          <div class="settings-title">Inventory</div>
        </div>
        <span class="badge ${inventoryEnabled ? 'badge-green' : 'badge-gray'}">${inventoryEnabled ? 'On' : 'Off'}</span>
      </div>
      <div class="settings-option-list">
        <label class="settings-option-row settings-option-toggle">
          <span class="settings-option-copy">
            <span class="settings-option-title">Use inventory on job lines</span>
          </span>
          <input id="settings-inventory-enabled" type="checkbox" ${inventoryEnabled ? 'checked' : ''} />
        </label>
      </div>
      <div class="settings-actions">
        <button class="btn btn-primary" onclick="saveInventorySettings()">Save inventory settings</button>
        <button class="btn" onclick="nav('inventory')">Open inventory</button>
      </div>
    </div>
  `;
}

function renderCloudSettingsCard() {
  const cloud = getCloudSession();
  const cloudForm = getCloudFormState();
  const cloudBadge = renderCloudStatusBadge(cloud);
  const signedIn = isCloudSignedIn();
  const isLoading = Boolean(cloudForm.loading);
  const authDisabled = !cloud.configured || isLoading;
  const accountEmail = cloud.account_email || '';
  const accountInitial = (accountEmail.trim()[0] || 'G').toUpperCase();
  return `
    <div class="card settings-card settings-account-card">
      <div class="settings-card-head">
        <div>
          <div class="settings-kicker">Account</div>
          <div class="settings-title">Garage Account</div>
        </div>
        ${cloudBadge}
      </div>
      ${signedIn ? `
        <div class="settings-account-row">
          <div class="settings-account-avatar">${escHtml(accountInitial)}</div>
          <div class="settings-account-copy">
            <div class="settings-account-email">${escHtml(accountEmail || 'Signed in')}</div>
            <div class="settings-account-status">Signed in</div>
          </div>
        </div>
        <div class="settings-actions settings-actions-stack">
          <button class="btn btn-primary" onclick="syncAccountToCloud()" ${!cloud.configured ? 'disabled' : ''}>Back up now</button>
          <button class="btn" onclick="restoreAccountFromCloud()" ${!cloud.configured ? 'disabled' : ''}>Restore data</button>
          <button class="btn" onclick="signOutCloudAccount()">Sign out</button>
        </div>
      ` : `
        <div class="cloud-auth-panel settings-auth-panel">
          ${renderCloudAuthNotice()}
          ${renderCloudAuthFields(cloudForm, authDisabled)}
          <div class="cloud-actions cloud-actions-two">
            ${renderCloudAuthActions(cloudForm, authDisabled, isLoading)}
          </div>
        </div>
      `}
    </div>
  `;
}

function renderSystemSettingsCard() {
  const appUpdate = getAppUpdateState();
  return `
    <div class="card settings-card">
      <div class="settings-card-head">
        <div>
          <div class="settings-kicker">System</div>
          <div class="settings-title">Updates</div>
        </div>
        <span class="badge ${appUpdate.configured ? (appUpdate.availableVersion ? 'badge-amber' : 'badge-green') : 'badge-gray'}">${appUpdate.configured ? (appUpdate.availableVersion ? 'Available' : 'Ready') : 'Setup'}</span>
      </div>
      <div class="settings-version-list">
        <div><span>Current</span><strong>${escHtml(appUpdate.currentVersion || 'Unknown')}</strong></div>
        <div><span>Available</span><strong>${escHtml(appUpdate.availableVersion || 'None')}</strong></div>
      </div>
      ${renderAppUpdateNotice(appUpdate)}
      ${appUpdate.availableNotes ? `<div class="settings-release-notes">${escHtml(appUpdate.availableNotes)}</div>` : ''}
      <div class="settings-actions">
        <button class="btn btn-primary" onclick="checkForAppUpdate()" ${!appUpdate.configured || appUpdate.checking || appUpdate.installing ? 'disabled' : ''}>${appUpdate.checking ? 'Checking...' : 'Check'}</button>
        <button class="btn" onclick="installAppUpdate()" ${!appUpdate.availableVersion || appUpdate.installing || appUpdate.checking ? 'disabled' : ''}>${appUpdate.installing ? 'Installing...' : 'Install'}</button>
      </div>
    </div>
  `;
}

async function renderSettings() {
  const activeCategory = normalizeSettingsCategory(state.settingsCategory);
  state.settingsCategory = activeCategory;
  const categoryContent = activeCategory === 'billing'
    ? await renderBilling()
    : ({
        garage: renderGarageSettingsCard(),
        booking: renderBookingSettingsCard(),
        inventory: renderInventorySettingsCard(),
        messages: renderMessagePreferencesCard(),
        account: renderCloudSettingsCard(),
        system: renderSystemSettingsCard(),
      })[activeCategory] || renderGarageSettingsCard();
  return `
  <div class="settings-shell">
    <div class="settings-category-layout">
      ${renderSettingsSubmenu(activeCategory)}
      <div class="settings-category-panel">
        ${categoryContent}
      </div>
    </div>
  </div>`;
}

// ── MODALS ────────────────────────────────────────────────────────────────
function getCalendarWeekLabel(days) {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return '';
  const sameMonth = first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear();
  const sameYear = first.getFullYear() === last.getFullYear();
  const firstLabel = first.toLocaleDateString('en-GB', sameMonth ? { day: 'numeric' } : (sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }));
  const lastLabel = last.toLocaleDateString('en-GB', { day: 'numeric', month: sameMonth ? 'long' : 'short', year: 'numeric' });
  return `${firstLabel} - ${lastLabel}`;
}

function getCalendarBookingTone(booking) {
  const status = String(booking?.status || '').trim().toLowerCase();
  if (status.includes('complete') || status === 'done') return 'gray';
  if (status.includes('progress') || status.includes('started')) return 'green';
  if (status.includes('pending') || status.includes('waiting')) return 'amber';
  return 'blue';
}

function renderCalendarView() {
  const today = new Date();
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - today.getDay() + 1 + state.calendarWeekOffset * 7);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(startOfWeek);
    d.setDate(startOfWeek.getDate() + i);
    return d;
  });
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const slotInterval = getBookingSlotInterval();
  const allowPastBookingTimes = getAllowPastBookingTimes();
  const timeSlots = getCalendarTimeSlots(slotInterval);
  const gridClass = slotInterval === 30 ? 'cal-grid cal-grid-compact' : 'cal-grid';
  const weekLabel = getCalendarWeekLabel(days);
  const bookingList = sortRows(state.bookings, 'calendar-bookings', {
    date: booking => booking.date,
    time: booking => booking.time,
    client: booking => booking.client_name,
    vehicle: booking => getBookingVehicleSummary(booking),
    reason: booking => booking.reason,
    status: booking => booking.status,
  }).slice(0, 20);

  return `
  <div class="calendar-shell">
  <div class="calendar-page-head">
    <div>
      <h1>Calendar</h1>
      <div class="dashboard-active-range">${escHtml(weekLabel)}</div>
    </div>
    <button class="btn btn-primary" onclick="showBookingFlow()">+ New booking</button>
  </div>
  <div class="card calendar-card">
    <div class="calendar-control-row">
      <div class="calendar-control-left">
        <select class="toolbar-select" aria-label="Calendar view" onchange="setCalendarViewMode(this.value)">
          <option value="day">Day</option>
          <option value="week" selected>Week</option>
          <option value="month">Month</option>
        </select>
        <strong class="calendar-range-label">${escHtml(weekLabel)}</strong>
        <button class="btn btn-icon" title="Previous week" onclick="changeCalendarWeek(-1)">&lsaquo;</button>
        <button class="btn btn-secondary btn-sm" onclick="goCalendarToday()">Today</button>
        <button class="btn btn-icon" title="Next week" onclick="changeCalendarWeek(1)">&rsaquo;</button>
      </div>
      <div class="calendar-control-right">
        <select class="toolbar-select" aria-label="Calendar slot size" onchange="setCalendarSlotInterval(this.value)">
          <option value="60" ${slotInterval === 60 ? 'selected' : ''}>Slot size: 1 hour</option>
          <option value="30" ${slotInterval === 30 ? 'selected' : ''}>Slot size: 30 min</option>
        </select>
        <select class="toolbar-select" aria-label="Past times" onchange="setPastBookingTimesMode(this.value)">
          <option value="hidden" ${allowPastBookingTimes ? '' : 'selected'}>Past times: Hidden</option>
          <option value="visible" ${allowPastBookingTimes ? 'selected' : ''}>Past times: Visible</option>
        </select>
        <button class="btn btn-primary btn-sm" onclick="showBookingFlow()">+ New booking</button>
      </div>
    </div>
    <div class="calendar-scroll">
    <div class="${gridClass}">
      <div class="cal-cell cal-header cal-time-head"></div>
      ${days.map((day, index) => {
        const isToday = day.toDateString() === today.toDateString();
        return `<div class="cal-cell cal-header ${isToday ? 'cal-today' : ''}"><div class="cal-day-name">${dayNames[index]}</div><div class="cal-day-date">${day.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</div></div>`;
      }).join('')}
      ${timeSlots.map(time => `
        <div class="cal-cell cal-time">${time}</div>
        ${days.map(day => {
          const dateStr = day.toISOString().slice(0, 10);
          const slotBookings = getCalendarSlotBookings(dateStr, time, slotInterval);
          const isToday = day.toDateString() === today.toDateString();
          const canBookSlot = canBookTime(dateStr, time);
          const bookButton = canBookSlot
            ? `<button class="cal-book-btn ${slotBookings.length ? 'cal-book-btn-inline' : ''}" onclick="showBookingFlow('${dateStr}','${time}')">+ Book</button>`
            : '';
          return `<div class="cal-cell cal-slot ${isToday ? 'cal-today' : ''} ${canBookSlot ? 'is-bookable' : 'is-past'}" ${canBookSlot ? `onclick="if(!event.target.closest('.cal-event,button')) showBookingFlow('${dateStr}','${time}')"` : ''}>
            ${slotBookings.length === 0 ? `<div class="cal-empty-slot">${bookButton}</div>` : `
              ${slotBookings.map(booking => renderCalendarBookingEvent(booking, getCalendarBookingTone(booking))).join('')}
              ${bookButton}
            `}
          </div>`;
        }).join('')}
      `).join('')}
    </div>
    </div>
    <div class="calendar-legend">
      <span><i class="legend-dot legend-blue"></i>Confirmed</span>
      <span><i class="legend-dot legend-green"></i>In progress</span>
      <span><i class="legend-dot legend-gray"></i>Completed</span>
    </div>
  </div>
  <div class="card data-table-card">
    <div class="card-header table-card-header"><span class="card-title">Recent bookings</span></div>
    <div class="table-scroll">
    <table class="data-table bookings-table"><thead><tr>${SortableTh('calendar-bookings','date','Date')}${SortableTh('calendar-bookings','time','Time')}${SortableTh('calendar-bookings','client','Customer')}${SortableTh('calendar-bookings','vehicle','Vehicle')}${SortableTh('calendar-bookings','reason','Reason')}${SortableTh('calendar-bookings','status','Status')}<th>Actions</th></tr></thead><tbody>
    ${bookingList.length === 0 ? renderEmptyTableRow(7, 'No bookings yet') : ''}
    ${bookingList.map(booking => `
    <tr class="clickable" onclick="showBookingModal(${booking.id})">
      <td>${renderDateCell(booking.date, 'No date')}</td>
      <td><strong>${escHtml(booking.time || '-')}</strong></td>
      <td>${renderEntityCell({ label: booking.client_name || 'Customer', avatarKey: booking.client_id || booking.client_name })}</td>
      <td>${renderVehicleStack({ make: getBookingMakeModel(booking), registration: getBookingRegistration(booking) })}</td>
      <td>${escHtml(booking.reason || '-')}</td>
      <td>${statusBadge(booking.status)}</td>
      <td>${renderRowActions(`showBookingModal(${booking.id})`, booking.status !== 'Cancelled' ? `cancelBooking(${booking.id})` : `restoreBooking(${booking.id})`)}</td>
    </tr>`).join('')}
    </tbody></table>
    </div>
    ${renderTableFooter(bookingList.length, 'bookings', state.bookings.length)}
  </div>
  </div>`;
}

function showModal(html, { preserveBookingDraft = false, persistState = null } = {}) {
  if (!preserveBookingDraft) state.bookingDraft = null;
  state.modalState = persistState;
  let overlay = document.getElementById('modal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'modal-overlay';
    overlay.addEventListener('pointerdown', e => {
      overlay.dataset.pointerDownBackdrop = e.target === overlay ? '1' : '0';
    });
    overlay.addEventListener('click', e => {
      const openedAt = Number(overlay.dataset.openedAt || 0);
      const pointerDownBackdrop = overlay.dataset.pointerDownBackdrop === '1';
      overlay.dataset.pointerDownBackdrop = '0';
      if (e.target === overlay && pointerDownBackdrop && Date.now() - openedAt > 150) closeModal();
    });
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = html;
  applyLanguageToDom(overlay);
  overlay.dataset.openedAt = String(Date.now());
  overlay.dataset.pointerDownBackdrop = '0';
  overlay.querySelector('.modal')?.addEventListener('pointerdown', e => e.stopPropagation());
  overlay.querySelector('.modal')?.addEventListener('click', e => e.stopPropagation());
}
function closeModal(rerenderInvoices = true) {
  const shouldRefreshInvoices = rerenderInvoices && state.invoiceEditorId !== null && state.screen === 'invoices';
  state.bookingDraft = null;
  state.invoiceCreateDraft = null;
  state.invoiceEditorId = null;
  state.invoiceEditorScrollTop = 0;
  state.modalState = null;
  document.getElementById('modal-overlay')?.remove();
  if (shouldRefreshInvoices) {
    void renderInPlace();
  }
}

async function setCalendarSlotInterval(interval) {
  const nextInterval = normalizeBookingSlotInterval(interval);
  if (getBookingSlotInterval() === nextInterval) return;
  state.settings = await invoke('save_app_settings', {
    settings: buildAppSettingsPayload({ booking_slot_interval: nextInterval })
  });
  await syncAfterCloudMutation();
  toast(`Calendar split: ${nextInterval === 30 ? '30 min' : '1 hour'}`);
  await render();
}

function setCalendarViewMode(mode) {
  const normalized = String(mode || 'week').toLowerCase();
  state.calendarViewMode = 'week';
  if (normalized !== 'week') toast('Week view is active');
  renderInPlace();
}

function goCalendarToday() {
  state.calendarWeekOffset = 0;
  renderInPlace();
}

async function togglePastBookingTimes() {
  const nextValue = !getAllowPastBookingTimes();
  state.settings = await invoke('save_app_settings', {
    settings: buildAppSettingsPayload({ allow_past_booking_times: nextValue })
  });
  await syncAfterCloudMutation();
  toast(nextValue ? 'Past-time booking enabled' : 'Past-time booking disabled');
  await render();
}

async function setPastBookingTimesMode(mode) {
  const nextValue = String(mode || '').toLowerCase() === 'visible';
  if (getAllowPastBookingTimes() === nextValue) return;
  state.settings = await invoke('save_app_settings', {
    settings: buildAppSettingsPayload({ allow_past_booking_times: nextValue })
  });
  await syncAfterCloudMutation();
  toast(nextValue ? 'Past times visible' : 'Past times hidden');
  await render();
}

function changeCalendarWeek(delta) {
  state.calendarWeekOffset += delta;
  render();
}

function createBookingDraft(presetDate, presetTime) {
  const initialSlot = getBookableBookingDateTime(presetDate, presetTime);
  return {
    search: '',
    clientMode: 'existing',
    vehicleMode: 'existing',
    selectedClientId: null,
    selectedVehicleId: null,
    clientName: '',
    clientPhone: '',
    clientEmail: '',
    clientCompany: '',
    clientNotes: '',
    vehicleRegistration: '',
    vehicleMake: '',
    vehicleModel: '',
    vehicleYear: '',
    serviceType: 'Full Service',
    concern: '',
    date: initialSlot.date,
    time: initialSlot.time,
    status: 'Confirmed',
    notes: '',
  };
}

function getBookingSearchResults(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { clients: [], vehicles: [] };
  return {
    clients: state.clients.filter(c =>
      [c.name, c.phone, c.email, c.company].some(v => String(v || '').toLowerCase().includes(q))
    ).slice(0, 5),
    vehicles: state.vehicles.filter(v =>
      [v.registration, v.make, v.model, v.client_name].some(val => String(val || '').toLowerCase().includes(q))
    ).slice(0, 5)
  };
}

function getSlotBookings(date, time) {
  return state.bookings
    .filter(b => b.date === date && b.time === time && b.status !== 'Cancelled')
    .slice()
    .sort((a, b) => `${a.time || ''}${a.client_name || ''}`.localeCompare(`${b.time || ''}${b.client_name || ''}`));
}

function getBookingVehicleRecord(booking) {
  return booking?.vehicle_id ? state.vehicles.find(v => Number(v.id) === Number(booking.vehicle_id)) || null : null;
}

function getBookingRegistration(booking) {
  return booking?.registration || getBookingVehicleRecord(booking)?.registration || '';
}

function getBookingMakeModel(booking) {
  const vehicle = getBookingVehicleRecord(booking);
  return [
    booking?.make || vehicle?.make,
    booking?.model || vehicle?.model,
  ].filter(Boolean).join(' ').trim();
}

function getBookingVehicleSummary(booking) {
  return [getBookingMakeModel(booking), getBookingRegistration(booking)].filter(Boolean).join(' - ') || 'Vehicle';
}

function renderCalendarBookingEvent(booking, colorName = 'blue') {
  const vehicleName = getBookingMakeModel(booking) || 'Vehicle details';
  const registration = getBookingRegistration(booking) || '-';
  const service = booking?.reason || 'Booking';
  const title = [booking?.time, booking?.client_name, vehicleName, registration, service].filter(Boolean).join(' - ');
  return `<div class="cal-event" style="background:var(--${colorName}-bg,var(--blue-bg));color:var(--${colorName}-text,var(--blue-text))" onclick="showBookingModal(${booking.id})" title="${escHtml(title)}">
    <strong class="cal-event-title">${escHtml(booking.time || '')} &middot; ${escHtml(booking.client_name || 'Customer')}</strong>
    <span class="cal-event-vehicle">${escHtml(vehicleName)}</span>
    <span class="cal-event-meta">${escHtml(registration)} &middot; ${escHtml(service)}</span>
  </div>`;
}

function getCalendarSlotBookings(date, slotTime, interval = getBookingSlotInterval()) {
  return state.bookings
    .filter(b => {
      if (b.date !== date || b.status === 'Cancelled') return false;
      if (interval === 30) return b.time === slotTime;
      return String(b.time || '').slice(0, 2) === String(slotTime || '').slice(0, 2);
    })
    .slice()
    .sort((a, b) => `${a.time || ''}${a.client_name || ''}`.localeCompare(`${b.time || ''}${b.client_name || ''}`));
}

function getSlotBookingCount(date, time) {
  return getSlotBookings(date, time).length;
}

function getNextCalendarSlot(days, hours) {
  const now = new Date();
  for (const day of days) {
    const date = day.toISOString().slice(0,10);
    for (const time of hours) {
      const candidate = new Date(`${date}T${time}:00`);
      if (!Number.isNaN(candidate.getTime()) && candidate >= now) return { date, time };
    }
  }
  return null;
}

function getSuggestedBookingTimes(date, selectedTime = '') {
  return getFilteredBookingTimeOptions(date, selectedTime, { preserveSelected: false }).slice(0, 8);
}

function showBookingFlow(presetDate, presetTime) {
  state.bookingDraft = createBookingDraft(presetDate, presetTime);
  showModal(renderBookingFlowModal(), { preserveBookingDraft: true });
  requestAnimationFrame(() => {
    document.getElementById('bf-search')?.focus();
  });
}

function renderBookingFlowInPlace() {
  const overlay = document.getElementById('modal-overlay');
  if (!overlay || !state.bookingDraft) return;
  const activeSnapshot = snapshotActiveField(overlay);
  overlay.innerHTML = renderBookingFlowModal();
  restoreActiveField(activeSnapshot);
}

function updateBookingSearch(value) {
  if (!state.bookingDraft) return;
  state.bookingDraft.search = value;
  state.bookingDraft.selectedClientId = null;
  state.bookingDraft.selectedVehicleId = null;
  renderBookingFlowInPlace();
}

function setBookingClientMode(mode) {
  if (!state.bookingDraft) return;
  state.bookingDraft.clientMode = mode;
  if (mode === 'new') {
    state.bookingDraft.selectedClientId = null;
    state.bookingDraft.selectedVehicleId = null;
    state.bookingDraft.vehicleMode = 'new';
  } else {
    state.bookingDraft.search = '';
    state.bookingDraft.vehicleMode = 'existing';
  }
  renderBookingFlowInPlace();
}

function selectBookingClient(clientId) {
  if (!state.bookingDraft) return;
  const clientVehicles = state.vehicles.filter(v => v.client_id === clientId);
  state.bookingDraft.clientMode = 'existing';
  state.bookingDraft.selectedClientId = clientId;
  state.bookingDraft.selectedVehicleId = clientVehicles[0]?.id || null;
  state.bookingDraft.vehicleMode = clientVehicles.length ? 'existing' : 'new';
  state.bookingDraft.search = '';
  renderBookingFlowInPlace();
}

function clearBookingClientSelection() {
  if (!state.bookingDraft) return;
  state.bookingDraft.selectedClientId = null;
  state.bookingDraft.selectedVehicleId = null;
  state.bookingDraft.search = '';
  state.bookingDraft.vehicleMode = 'existing';
  renderBookingFlowInPlace();
}

function selectBookingVehicle(vehicleId) {
  if (!state.bookingDraft) return;
  const vehicle = state.vehicles.find(v => v.id === vehicleId);
  if (!vehicle) return;
  state.bookingDraft.clientMode = 'existing';
  state.bookingDraft.vehicleMode = 'existing';
  state.bookingDraft.selectedClientId = vehicle.client_id;
  state.bookingDraft.selectedVehicleId = vehicle.id;
  state.bookingDraft.search = '';
  renderBookingFlowInPlace();
}

function setBookingVehicleMode(mode) {
  if (!state.bookingDraft) return;
  state.bookingDraft.vehicleMode = mode;
  if (mode === 'new') {
    state.bookingDraft.selectedVehicleId = null;
  } else {
    const clientVehicles = state.vehicles.filter(v => v.client_id === state.bookingDraft.selectedClientId);
    state.bookingDraft.selectedVehicleId = clientVehicles[0]?.id || null;
  }
  renderBookingFlowInPlace();
}

function updateBookingDate(value) {
  if (!state.bookingDraft) return;
  state.bookingDraft.date = value;
  const nextOptions = getFilteredBookingTimeOptions(value, state.bookingDraft.time, { preserveSelected: false });
  if (nextOptions.length && !nextOptions.includes(state.bookingDraft.time)) {
    state.bookingDraft.time = nextOptions[0];
  } else if (!nextOptions.length && !getAllowPastBookingTimes()) {
    state.bookingDraft.time = '';
  }
  renderBookingFlowInPlace();
}

function chooseBookingTime(time) {
  if (!state.bookingDraft) return;
  state.bookingDraft.time = time;
  renderBookingFlowInPlace();
}

function readBookingDraftInputs() {
  const draft = state.bookingDraft;
  if (!draft) return null;
  const bindings = [
    ['bf-client-name', 'clientName'],
    ['bf-client-phone', 'clientPhone'],
    ['bf-client-email', 'clientEmail'],
    ['bf-client-company', 'clientCompany'],
    ['bf-client-notes', 'clientNotes'],
    ['bf-vehicle-reg', 'vehicleRegistration'],
    ['bf-vehicle-make', 'vehicleMake'],
    ['bf-vehicle-model', 'vehicleModel'],
    ['bf-vehicle-year', 'vehicleYear'],
    ['bf-service-type', 'serviceType'],
    ['bf-concern', 'concern'],
    ['bf-date', 'date'],
    ['bf-time', 'time'],
    ['bf-status', 'status'],
    ['bf-booking-notes', 'notes'],
  ];
  bindings.forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (el) draft[key] = el.value;
  });
  return draft;
}

function renderBookingFlowModal() {
  const draft = state.bookingDraft;
  const searchResults = getBookingSearchResults(draft.search);
  const selectedClient = state.clients.find(c => c.id === draft.selectedClientId) || null;
  const selectedVehicle = state.vehicles.find(v => v.id === draft.selectedVehicleId) || null;
  const clientVehicles = selectedClient ? state.vehicles.filter(v => v.client_id === selectedClient.id) : [];
  const vehicleChoices = selectedVehicle
    ? clientVehicles.filter(v => Number(v.id) !== Number(selectedVehicle.id))
    : clientVehicles;
  const timeOptions = getFilteredBookingTimeOptions(draft.date, draft.time);
  const suggestedTimes = getSuggestedBookingTimes(draft.date, draft.time);
  const slotBookingCount = getSlotBookingCount(draft.date, draft.time);
  const slotTimePassed = Boolean(draft.time) && !canBookTime(draft.date, draft.time);
  const summaryClient = draft.clientMode === 'existing'
    ? (selectedClient ? selectedClient.name : 'Choose or search a customer')
    : (draft.clientName || 'Unknown customer');
  const summaryVehicle = draft.vehicleMode === 'existing'
    ? (selectedVehicle ? `${selectedVehicle.registration} — ${selectedVehicle.make} ${selectedVehicle.model}`.trim() : 'Choose a vehicle')
    : (draft.vehicleRegistration || 'New vehicle details');
  const summaryReason = draft.concern ? `${draft.serviceType} — ${draft.concern}` : draft.serviceType;

  return `
  <div class="modal booking-flow-modal">
    <div class="booking-flow-head booking-flow-head-modal">
      <div>
        <h2>New booking</h2>
      </div>
      <div class="booking-slot-state ${slotTimePassed || slotBookingCount ? 'is-busy' : 'is-free'}">${slotTimePassed ? 'Past time blocked' : (slotBookingCount ? `${slotBookingCount} booking${slotBookingCount === 1 ? '' : 's'} at this time` : 'No bookings yet')} · ${fmtDate(draft.date)} ${escHtml(draft.time || '-')}</div>
    </div>
    <div class="booking-step-strip booking-step-strip-modal">
      <div class="booking-step-card"><div class="booking-step-num">1</div><div><div class="booking-step-title">Customer</div></div></div>
      <div class="booking-step-card"><div class="booking-step-num">2</div><div><div class="booking-step-title">Vehicle</div></div></div>
      <div class="booking-step-card"><div class="booking-step-num">3</div><div><div class="booking-step-title">Service</div></div></div>
    </div>
    <div class="booking-flow-grid">
      <div>
        <div class="booking-panel">
          <div class="booking-panel-head">
            <span class="card-title">1. Customer</span>
            <div class="segmented">
              <button class="btn btn-sm ${draft.clientMode === 'existing' ? 'btn-primary' : ''}" onclick="setBookingClientMode('existing')">Find customer</button>
              <button class="btn btn-sm ${draft.clientMode === 'new' ? 'btn-primary' : ''}" onclick="setBookingClientMode('new')">New customer</button>
            </div>
          </div>
          ${draft.clientMode === 'existing' ? `
            ${selectedClient ? `
              <div class="choice-card active">
                <div class="choice-title">${escHtml(selectedClient.name)}</div>
                <div class="text-sm text-muted">${escHtml(selectedClient.phone || 'No phone')} · ${escHtml(selectedClient.email || 'No email')}</div>
                <div class="choice-actions"><button class="btn btn-sm" onclick="clearBookingClientSelection()">Change</button><button class="btn btn-sm" onclick="setBookingClientMode('new')">New customer</button></div>
              </div>
            ` : `
              <div class="form-row">
                <label>Search phone, name or registration</label>
                <input id="bf-search" type="text" value="${escHtml(draft.search)}" placeholder="e.g. 077..., John Smith, AB12 CDE" oninput="updateBookingSearch(this.value)" />
              </div>
              ${draft.search ? `<div class="booking-search-meta">${searchResults.clients.length} customer(s), ${searchResults.vehicles.length} vehicle(s)</div>` : ''}
              ${draft.search ? `
                <div class="booking-match-grid">
                  ${searchResults.clients.length ? `
                    <div>
                      <div class="booking-match-title">Customers</div>
                      <div class="booking-match-list">
                        ${searchResults.clients.map(c => `<button class="choice-card choice-card-button" onclick="selectBookingClient(${c.id})"><div class="choice-title">${escHtml(c.name)}</div><div class="text-sm text-muted">${escHtml(c.phone || 'No phone')}</div></button>`).join('')}
                      </div>
                    </div>
                  ` : ''}
                  ${searchResults.vehicles.length ? `
                    <div>
                      <div class="booking-match-title">Vehicles</div>
                      <div class="booking-match-list">
                        ${searchResults.vehicles.map(v => `<button class="choice-card choice-card-button" onclick="selectBookingVehicle(${v.id})"><div class="choice-title">${escHtml(v.registration)}</div><div class="text-sm text-muted">${escHtml(v.client_name)} · ${escHtml(`${v.make} ${v.model}`.trim())}</div></button>`).join('')}
                      </div>
                    </div>
                  ` : ''}
                </div>
              ` : '<div class="booking-empty">Search or create a new customer.</div>'}
              ${draft.search && !searchResults.clients.length && !searchResults.vehicles.length ? `
                <div class="booking-empty">
                  No matches found.
                  <div class="choice-actions"><button class="btn btn-sm btn-primary" onclick="setBookingClientMode('new')">Create customer</button></div>
                </div>
              ` : ''}
            `}
          ` : `
            <div class="form-grid">
              <div class="form-row"><label>Customer name</label><input id="bf-client-name" type="text" value="${escHtml(draft.clientName)}" oninput="state.bookingDraft.clientName=this.value" /></div>
              <div class="form-row"><label>Phone</label><input id="bf-client-phone" type="text" value="${escHtml(draft.clientPhone)}" oninput="state.bookingDraft.clientPhone=this.value" /></div>
              <div class="form-row"><label>Email</label><input id="bf-client-email" type="email" value="${escHtml(draft.clientEmail)}" oninput="state.bookingDraft.clientEmail=this.value" /></div>
              <div class="form-row"><label>Company</label><input id="bf-client-company" type="text" value="${escHtml(draft.clientCompany)}" oninput="state.bookingDraft.clientCompany=this.value" /></div>
            </div>
            <div class="form-row"><label>Customer notes</label><textarea id="bf-client-notes" oninput="state.bookingDraft.clientNotes=this.value">${escHtml(draft.clientNotes)}</textarea></div>
          `}
        </div>

        <div class="booking-panel">
          <div class="booking-panel-head">
            <span class="card-title">2. Vehicle</span>
            <div class="segmented">
              <button class="btn btn-sm ${draft.vehicleMode === 'existing' ? 'btn-primary' : ''}" onclick="setBookingVehicleMode('existing')" ${draft.clientMode === 'new' && !draft.clientName ? '' : ''}>Choose Existing</button>
              <button class="btn btn-sm ${draft.vehicleMode === 'new' ? 'btn-primary' : ''}" onclick="setBookingVehicleMode('new')">Add Vehicle</button>
            </div>
          </div>
          ${draft.vehicleMode === 'existing' ? `
            ${selectedVehicle ? `
              <div class="choice-card active">
                <div class="choice-title">${escHtml(selectedVehicle.registration)}</div>
                <div class="text-sm text-muted">${escHtml(`${selectedVehicle.make} ${selectedVehicle.model}`.trim() || 'Vehicle details can be filled in later')}</div>
              </div>
            ` : ''}
            ${selectedClient && vehicleChoices.length ? `
              <div class="choice-grid">
                ${vehicleChoices.map(v => `<button class="choice-card choice-card-button" onclick="selectBookingVehicle(${v.id})"><div class="choice-title">${escHtml(v.registration)}</div><div class="text-sm text-muted">${escHtml(`${v.make} ${v.model}`.trim() || 'Vehicle')}</div></button>`).join('')}
              </div>
            ` : (!selectedVehicle ? '<div class="booking-empty">Choose a customer or add a vehicle.</div>' : '')}
          ` : `
            <div class="form-grid">
              <div class="form-row">
                <label>Registration *</label>
                <div class="input-action-row">
                  <input id="bf-vehicle-reg" type="text" value="${escHtml(draft.vehicleRegistration)}" oninput="state.bookingDraft.vehicleRegistration=this.value.toUpperCase()" style="text-transform:uppercase" />
                  <button class="btn btn-sm" onclick="lookupDvlaVehicle('booking')">Check DVLA</button>
                </div>
                <div id="bf-dvla-status" class="lookup-status"></div>
              </div>
              <div class="form-row"><label>Make</label><input id="bf-vehicle-make" type="text" value="${escHtml(draft.vehicleMake)}" oninput="state.bookingDraft.vehicleMake=this.value" /></div>
              <div class="form-row"><label>Model (optional)</label><input id="bf-vehicle-model" type="text" value="${escHtml(draft.vehicleModel)}" oninput="state.bookingDraft.vehicleModel=this.value" /></div>
              <div class="form-row"><label>Year</label><input id="bf-vehicle-year" type="number" value="${escHtml(draft.vehicleYear)}" oninput="state.bookingDraft.vehicleYear=this.value" /></div>
            </div>
          `}
        </div>

        <div class="booking-panel">
          <div class="booking-panel-head"><span class="card-title">3. Service & Slot</span></div>
          <div class="form-grid">
            <div class="form-row">
              <label>Service type *</label>
              <select id="bf-service-type" onchange="state.bookingDraft.serviceType=this.value">
                ${BOOKING_SERVICE_TYPES.map(type => `<option ${draft.serviceType === type ? 'selected' : ''}>${type}</option>`).join('')}
              </select>
            </div>
            <div class="form-row">
              <label>Status</label>
              <select id="bf-status" onchange="state.bookingDraft.status=this.value">
                ${['Confirmed','Pending','Cancelled'].map(status => `<option ${(draft.status || 'Confirmed') === status ? 'selected' : ''}>${status}</option>`).join('')}
              </select>
            </div>
            <div class="form-row"><label>Date *</label><input id="bf-date" type="date" value="${draft.date}" onchange="updateBookingDate(this.value)" /></div>
            <div class="form-row">
              <label>Time *</label>
              <select id="bf-time" onchange="state.bookingDraft.time=this.value">
                ${renderBookingTimeOptions(timeOptions, draft.time)}
              </select>
            </div>
          </div>
          ${!timeOptions.length ? '<div class="booking-empty compact">No bookable times remain for this date. Choose another date or turn on <strong>Past times</strong> in the calendar.</div>' : ''}
          <div class="form-row"><label>Customer concern</label><input id="bf-concern" type="text" value="${escHtml(draft.concern)}" placeholder="e.g. annual service and brake check" oninput="state.bookingDraft.concern=this.value" /></div>
          <div class="form-row"><label>Booking notes</label><textarea id="bf-booking-notes" oninput="state.bookingDraft.notes=this.value">${escHtml(draft.notes)}</textarea></div>
          <div class="form-row">
            <label>Quick time picks</label>
            <div class="slot-chip-row">
              ${suggestedTimes.map(time => `<button class="slot-chip ${draft.time === time ? 'active' : ''}" onclick="chooseBookingTime('${time}')">${time}</button>`).join('')}
            </div>
          </div>
        </div>
      </div>

      <div>
        <div class="booking-panel booking-summary-panel">
          <div class="card-title">Summary</div>
          <div class="booking-summary-list">
            <div class="booking-summary-item"><span class="booking-summary-label">Customer</span><strong>${escHtml(summaryClient)}</strong></div>
            <div class="booking-summary-item"><span class="booking-summary-label">Vehicle</span><strong>${escHtml(summaryVehicle)}</strong></div>
            <div class="booking-summary-item"><span class="booking-summary-label">Service</span><strong>${escHtml(summaryReason)}</strong></div>
            <div class="booking-summary-item"><span class="booking-summary-label">Slot</span><strong>${fmtDate(draft.date)} · ${escHtml(draft.time)}</strong></div>
          </div>
          <div class="booking-summary-note ${slotTimePassed || slotBookingCount ? 'warning' : ''}">
            ${slotTimePassed ? 'This time has already passed. Turn on Past times in the calendar or choose a later slot.' : (slotBookingCount ? `This time already has ${slotBookingCount} booking${slotBookingCount === 1 ? '' : 's'}. You can still add more vehicles to the same slot.` : 'Selected time is currently empty in the calendar.')}
          </div>
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveBookingFlow()">Save booking</button>
    </div>
  </div>`;
}

async function saveBookingFlow() {
  const draft = readBookingDraftInputs();
  if (!draft) return;
  try {
    if (!draft.date || !draft.time) { alert('Choose a date and time'); return; }
    if (!canBookTime(draft.date, draft.time)) { alert('This time has already passed. Turn on Past times in the calendar or choose another slot.'); return; }
    if (!(await ensureBookingCreationAllowed(draft.date))) return;
    const willCreateVehicle = draft.vehicleMode === 'new';
    if (willCreateVehicle) {
      if (!draft.vehicleRegistration.trim()) { alert('Registration is required'); return; }
      if (!(await ensureVehicleCreationAllowed())) return;
    }

    let clientId = draft.selectedClientId;
    let smsClient = getClientById(clientId);
    if (draft.clientMode === 'new') {
      const clientName = draft.clientName.trim();
      const clientPhone = draft.clientPhone.trim();
      const clientEmail = draft.clientEmail.trim();
      const clientCompany = draft.clientCompany.trim();
      const clientNotes = draft.clientNotes.trim();
      const hasClientDetails = Boolean(clientName || clientPhone || clientEmail || clientCompany || clientNotes);

      if (!hasClientDetails) {
        clientId = await getOrCreateUnknownCustomer();
        smsClient = getClientById(clientId) || getUnknownCustomerFallback(clientId);
      } else {
        if (!(await ensureCustomerCreationAllowed())) return;
        const savedClientName = clientName || getNextUnknownCustomerName();
        clientId = await invoke('save_client', {
          client: {
            id: null,
            name: savedClientName,
            phone: clientPhone,
            email: clientEmail,
            address: '',
            company: clientCompany,
            notes: clientNotes,
          }
        });
        smsClient = {
          id: clientId,
          name: savedClientName,
          phone: clientPhone,
          email: clientEmail,
        };
        await syncAfterCloudMutation();
      }
    }
    if (!clientId && draft.vehicleMode === 'new' && draft.vehicleRegistration.trim()) {
      clientId = await getOrCreateUnknownCustomer();
      smsClient = getClientById(clientId) || getUnknownCustomerFallback(clientId);
    }
    if (!clientId) { alert('Select an existing customer, create a customer, or add a vehicle registration.'); return; }
    smsClient = smsClient || getClientById(clientId);

    let vehicleId = draft.selectedVehicleId;
    let smsVehicle = getVehicleById(vehicleId);
    if (willCreateVehicle) {
      vehicleId = await invoke('save_vehicle', {
        vehicle: {
          id: null,
          client_id: clientId,
          registration: draft.vehicleRegistration.trim().toUpperCase(),
          vin: '',
          make: draft.vehicleMake.trim(),
          model: draft.vehicleModel.trim(),
          year: parseInt(draft.vehicleYear, 10) || 0,
          engine: '',
          fuel_type: '',
          colour: '',
          mileage: 0,
          mot_due: '',
          service_due: '',
          notes: '',
        }
      });
      smsVehicle = {
        id: vehicleId,
        client_id: clientId,
        registration: draft.vehicleRegistration.trim().toUpperCase(),
        make: draft.vehicleMake.trim(),
        model: draft.vehicleModel.trim(),
      };
      await recordVehicleCreatedForBilling();
      await syncAfterCloudMutation();
    }
    if (!vehicleId) { alert('Select an existing vehicle or add a new one'); return; }
    smsVehicle = smsVehicle || getVehicleById(vehicleId);

    const reason = draft.concern.trim() ? `${draft.serviceType} — ${draft.concern.trim()}` : draft.serviceType;
    const bookingPayload = {
      id: null,
      client_id: clientId,
      vehicle_id: vehicleId,
      date: draft.date,
      time: draft.time,
      reason,
      status: draft.status || 'Confirmed',
      notes: draft.notes.trim(),
    };
    const bookingId = await invoke('save_booking', {
      booking: bookingPayload
    });
    await sendAutomaticBookingSms({ ...bookingPayload, id: bookingId, client_name: smsClient?.name || '', registration: smsVehicle?.registration || '' }, smsClient, smsVehicle);
    await syncAfterCloudMutation();
    closeModal();
    toast('Service booked');
    state.screen = 'calendar';
    await render();
  } catch (error) {
    alert(String(error));
  }
}

function showClientModal(clientId, { persist = true } = {}) {
  const c = clientId ? state.clients.find(x=>x.id===clientId) : null;
  const persistState = persist ? { kind: 'client', clientId: clientId || null } : state.modalState;
  showModal(`<div class="modal">
    <h2>${c ? 'Edit Customer' : 'New Customer'}</h2>
    <div class="form-grid">
      <div class="form-row"><label>Full name *</label><input id="c-name" type="text" value="${escHtml(c?.name||'')}" /></div>
      <div class="form-row"><label>Phone</label><input id="c-phone" type="text" value="${escHtml(c?.phone||'')}" /></div>
      <div class="form-row"><label>Email</label><input id="c-email" type="email" value="${escHtml(c?.email||'')}" /></div>
      <div class="form-row"><label>Company (B2B)</label><input id="c-company" type="text" value="${escHtml(c?.company||'')}" /></div>
    </div>
    <div class="form-row"><label>Address</label><input id="c-address" type="text" value="${escHtml(c?.address||'')}" /></div>
    <div class="form-row"><label>Notes</label><textarea id="c-notes">${escHtml(c?.notes||'')}</textarea></div>
    <div class="modal-footer">
      ${c ? `<button class="btn btn-danger btn-sm" onclick="deleteClient(${c.id})">Delete</button><span style="flex:1"></span>` : ''}
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveClient(${clientId||'null'})">Save</button>
    </div>
  </div>`, { persistState });
}

async function saveClient(clientId) {
  const name = document.getElementById('c-name').value.trim();
  if (!name) { alert('Name is required'); return; }
  if (!clientId && !(await ensureCustomerCreationAllowed())) return;
  const client = {
    id: clientId || null, name,
    phone: document.getElementById('c-phone').value,
    email: document.getElementById('c-email').value,
    address: document.getElementById('c-address').value,
    company: document.getElementById('c-company').value,
    notes: document.getElementById('c-notes').value,
  };
  const savedClientId = await invoke('save_client', { client });
  await syncAfterCloudMutation();
  closeModal();
  toast('Customer saved');

  if (!clientId) {
    await openClient(savedClientId);
    showVehicleModal(null, savedClientId);
    return;
  }

  render();
}

async function deleteClient(id) {
  if (!confirm('Delete this customer? Owned vehicles will also be deleted if they are not used in jobs or bookings.')) return;
  try {
    await invoke('delete_client', { id });
    await syncAfterCloudMutation();
    closeModal(); state.selectedClient = null; toast('Customer deleted'); render();
  } catch (error) {
    alert(String(error));
  }
}

async function signUpCloudAccount() {
  const form = getCloudFormState();
  const email = form.email.trim();
  const password = form.password || '';
  const confirmPassword = form.confirmPassword || '';
  const garageName = (form.garageName || getGarageName()).trim();
  if (form.loading) return;
  if (!email) {
    setCloudAuthNotice('Enter email address.', 'red');
    await renderInPlace();
    return;
  }
  if (password.length < 8) {
    setCloudAuthNotice('Password must be at least 8 characters.', 'red');
    await renderInPlace();
    return;
  }
  if (password !== confirmPassword) {
    setCloudAuthNotice('Passwords do not match.', 'red');
    await renderInPlace();
    return;
  }

  setCloudAuthLoading(true);
  setCloudAuthNotice('', 'blue');
  await renderInPlace();

  let shouldRenderFullApp = false;
  try {
    const result = await signUpWithSupabase(email, password, garageName);
    state.cloud = { ...state.cloud, ...(result.status || {}) };
    form.password = '';
    form.confirmPassword = '';

    if (result.signedIn && result.session) {
      setCloudAuthNotice(result.message || 'Account created. You are now signed in.', 'green');
      try {
        const restoreResult = await restoreCloudWorkspace({ force: true });
        if (restoreResult?.restored === false) {
          toast('Account created');
        } else {
          toast('Account created and data loaded');
        }
      } catch (restoreError) {
        console.warn(restoreError);
        toast('Account created');
      }
      consumeGarageSetupPending(email);
      openGarageSetupAfterSignup();
      shouldRenderFullApp = true;
    } else {
      rememberGarageSetupPending(email);
      form.mode = 'verify';
      form.verificationCode = '';
      setCloudAuthNotice('Check your email and enter the verification code.', 'green');
      toast('Verification code sent');
    }
  } catch (error) {
    setCloudAuthNotice(getErrorMessage(error), 'red');
  } finally {
    setCloudAuthLoading(false);
    if (shouldRenderFullApp) {
      await render();
      return;
    }
    await renderInPlace();
  }
}

async function verifyCloudEmailCode() {
  const form = getCloudFormState();
  const email = form.email.trim();
  const code = String(form.verificationCode || '').trim();
  if (form.loading) return;
  if (!email) {
    setCloudAuthNotice('Enter email address.', 'red');
    await renderInPlace();
    return;
  }
  if (!/^\d{6,8}$/.test(code)) {
    setCloudAuthNotice('Enter the verification code from your email.', 'red');
    await renderInPlace();
    return;
  }

  setCloudAuthLoading(true);
  setCloudAuthNotice('', 'blue');
  await renderInPlace();

  try {
    await verifyEmailCode(email, code);
    form.mode = 'login';
    form.password = '';
    form.confirmPassword = '';
    form.verificationCode = '';
    setCloudAuthNotice('Email verified. You can now log in with your email and password.', 'green');
    toast('Email verified');
  } catch (error) {
    setCloudAuthNotice(getErrorMessage(error), 'red');
  } finally {
    setCloudAuthLoading(false);
    await renderInPlace();
  }
}

async function resendCloudVerificationCode() {
  const form = getCloudFormState();
  const email = form.email.trim();
  if (form.loading) return;
  if (!email) {
    setCloudAuthNotice('Enter email address first.', 'red');
    await renderInPlace();
    return;
  }

  setCloudAuthLoading(true);
  setCloudAuthNotice('', 'blue');
  await renderInPlace();

  try {
    await resendSignUpCode(email);
    form.verificationCode = '';
    setCloudAuthNotice('A fresh verification code has been sent to your email.', 'green');
    toast('Verification code sent');
  } catch (error) {
    setCloudAuthNotice(getErrorMessage(error), 'red');
  } finally {
    setCloudAuthLoading(false);
    await renderInPlace();
  }
}

async function signInCloudAccount() {
  const form = getCloudFormState();
  const email = form.email.trim();
  const password = form.password || '';
  if (form.loading) return;
  if (!email) {
    setCloudAuthNotice('Enter email address.', 'red');
    await renderInPlace();
    return;
  }
  if (!password) {
    setCloudAuthNotice('Enter password.', 'red');
    await renderInPlace();
    return;
  }

  setCloudAuthLoading(true);
  setCloudAuthNotice('', 'blue');
  await renderInPlace();

  let shouldRenderFullApp = false;
  try {
    const result = await signInWithSupabase(email, password);
    state.cloud = { ...state.cloud, ...(result.status || {}) };
    form.password = '';
    form.confirmPassword = '';
    setCloudAuthNotice(result.message || 'Logged in successfully.', 'green');
    try {
      const restoreResult = await restoreCloudWorkspace({ force: true });
      if (restoreResult?.restored === false) {
        toast('Logged in. No backup data yet for this account.');
      } else {
        toast('Logged in and data loaded');
      }
    } catch (restoreError) {
      console.warn(restoreError);
      toast('Logged in');
    }
    if (consumeGarageSetupPending(email)) {
      openGarageSetupAfterSignup();
    } else {
      resetToDashboardAfterLogin();
    }
    shouldRenderFullApp = true;
  } catch (error) {
    setCloudAuthNotice(getErrorMessage(error), 'red');
  } finally {
    setCloudAuthLoading(false);
    if (shouldRenderFullApp) {
      await render();
      return;
    }
    await renderInPlace();
  }
}

async function signOutCloudAccount() {
  if (!confirm('Sign out from this device?')) return;
  try {
    await signOutFromSupabase();
    clearLoadedBusinessState();
    state.cloudHydratedUserId = '';
    state.cloud = { ...state.cloud, user_id: '', account_email: '', access_token: '', refresh_token: '', last_synced_at: '' };
    setCloudAuthNotice('Signed out. You can log in again on this device.', 'blue');
    toast('Signed out');
    await render();
  } catch (error) {
    alert(getErrorMessage(error));
  }
}

async function syncAccountToCloud() {
  try {
    await syncAfterCloudMutation();
    toast('Garage backed up');
    await render();
  } catch (error) {
    alert(String(error));
  }
}

async function restoreAccountFromCloud() {
  if (!confirm('Restore account data? This will replace the current local data on this device.')) return;
  try {
    const result = await restoreCloudWorkspace({ force: true });
    toast(result?.restored === false ? 'No backup data yet for this account' : 'Local data restored');
    state.selectedClient = null;
    state.selectedJob = null;
    state.selectedInvoice = null;
    await render();
  } catch (error) {
    alert(String(error));
  }
}

async function sendCloudPasswordReset() {
  const form = getCloudFormState();
  const email = form.email.trim();
  if (form.loading) return;
  if (!email) {
    setCloudAuthNotice('Enter email address first.', 'red');
    await renderInPlace();
    return;
  }

  setCloudAuthLoading(true);
  setCloudAuthNotice('', 'blue');
  await renderInPlace();

  try {
    await resetSupabasePassword(email);
    setCloudAuthNotice('Password recovery email sent. Open the newest email on this device; the link should open Garage CRM.', 'blue');
    toast('Password recovery email sent');
  } catch (error) {
    setCloudAuthNotice(getErrorMessage(error), 'red');
  } finally {
    setCloudAuthLoading(false);
    await renderInPlace();
  }
}

async function completeCloudPasswordReset() {
  const form = getCloudFormState();
  const password = form.password || '';
  const confirmPassword = form.confirmPassword || '';
  if (form.loading) return;
  if (password.length < 8) {
    setCloudAuthNotice('Password must be at least 8 characters.', 'red');
    await renderInPlace();
    return;
  }
  if (password !== confirmPassword) {
    setCloudAuthNotice('Passwords do not match.', 'red');
    await renderInPlace();
    return;
  }

  setCloudAuthLoading(true);
  setCloudAuthNotice('', 'blue');
  await renderInPlace();

  try {
    await completeSupabasePasswordReset(password);
    form.mode = 'login';
    form.password = '';
    form.confirmPassword = '';
    setCloudAuthNotice('Password changed. Log in with the new password.', 'green');
    toast('Password changed');
  } catch (error) {
    setCloudAuthNotice(getErrorMessage(error), 'red');
  } finally {
    setCloudAuthLoading(false);
    await refreshCloudAccountStatus();
    await renderInPlace();
  }
}

function showVehicleModal(vehicleId, presetClientId, { persist = true } = {}) {
  const v = vehicleId ? state.vehicles.find(x=>x.id===vehicleId) : null;
  const persistState = persist ? { kind: 'vehicle', vehicleId: vehicleId || null, presetClientId: presetClientId || null } : state.modalState;
  const smsHistory = v ? getSmsHistoryForEntity({ vehicleId: v.id }) : [];
  showModal(`<div class="modal modal-wide">
    <h2>${v ? 'Edit Vehicle' : 'New Vehicle'}</h2>
    <div class="form-row"><label>Owner</label>
      <select id="v-client">
        <option value="">Unknown customer / walk-in</option>
        ${state.clients.map(c=>`<option value="${c.id}" ${(v?.client_id===c.id||presetClientId===c.id)?'selected':''}>${escHtml(c.name)}</option>`).join('')}
      </select>
      <div class="entity-subtitle">Leave empty when the customer name or phone is not known yet.</div>
    </div>
    <div class="form-grid-3">
      <div class="form-row">
        <label>Registration *</label>
        <div class="input-action-row">
          <input id="v-reg" type="text" value="${escHtml(v?.registration||'')}" style="text-transform:uppercase" />
          <button class="btn btn-sm" onclick="lookupDvlaVehicle('vehicle')">Check DVLA</button>
        </div>
        <div id="v-dvla-status" class="lookup-status"></div>
      </div>
      <div class="form-row"><label>VIN</label><input id="v-vin" type="text" value="${escHtml(v?.vin||'')}" /></div>
      <div class="form-row"><label>Make</label><input id="v-make" type="text" value="${escHtml(v?.make||'')}" /></div>
      <div class="form-row"><label>Model (optional)</label><input id="v-model" type="text" value="${escHtml(v?.model||'')}" /></div>
      <div class="form-row"><label>Year</label><input id="v-year" type="number" value="${v?.year||''}" /></div>
      <div class="form-row"><label>Engine</label><input id="v-engine" type="text" value="${escHtml(v?.engine||'')}" /></div>
      <div class="form-row"><label>Fuel type</label>
        <select id="v-fuel">
          ${['Petrol','Diesel','Hybrid','Electric','LPG'].map(f=>`<option ${(v?.fuel_type||'Petrol')===f?'selected':''}>${f}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>Colour</label><input id="v-colour" type="text" value="${escHtml(v?.colour||'')}" /></div>
      <div class="form-row"><label>${getDistanceLabelWithUnit()}</label><input id="v-mileage" type="number" value="${v?.mileage||0}" /></div>
      <div class="form-row"><label>MOT due</label><input id="v-mot" type="date" value="${v?.mot_due||''}" /></div>
      <div class="form-row"><label>Service due</label><input id="v-service" type="date" value="${v?.service_due||''}" /></div>
    </div>
    <div class="form-row"><label>Notes</label><textarea id="v-notes">${escHtml(v?.notes||'')}</textarea></div>
    ${v ? `
      <div class="message-action-footer" style="justify-content:flex-start;margin-top:10px">
        <button class="btn btn-sm" onclick="showVehicleSmsModal(${v.id})">Send SMS</button>
        <button class="btn btn-sm" onclick="showVehicleSmsModal(${v.id},'MOT')">Send MOT reminder</button>
        <button class="btn btn-sm" onclick="showVehicleSmsModal(${v.id},'SERVICE')">Send service reminder</button>
      </div>
      <div class="card-title" style="margin:16px 0 8px">SMS history</div>
      ${renderSmsHistoryList(smsHistory, 'No SMS history for this vehicle yet')}
    ` : ''}
    <div class="modal-footer">
      ${v ? `<button class="btn btn-danger btn-sm" onclick="deleteVehicle(${v.id})">Delete</button><span style="flex:1"></span>` : ''}
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveVehicle(${vehicleId||'null'})">Save</button>
    </div>
  </div>`, { persistState });
}

async function saveVehicle(vehicleId) {
  let clientId = parseInt(document.getElementById('v-client').value) || 0;
  const reg = document.getElementById('v-reg').value.trim().toUpperCase();
  if (!reg) { alert('Registration required'); return; }
  const isNewVehicle = !vehicleId;
  if (isNewVehicle && !(await ensureVehicleCreationAllowed())) return;
  const usedUnknownCustomer = !clientId;
  if (!clientId) {
    clientId = await getOrCreateUnknownCustomer();
    if (!clientId) return;
  }
  const vehicle = {
    id: vehicleId || null, client_id: clientId,
    registration: reg,
    vin: document.getElementById('v-vin').value,
    make: document.getElementById('v-make').value,
    model: document.getElementById('v-model').value,
    year: parseInt(document.getElementById('v-year').value)||0,
    engine: document.getElementById('v-engine').value,
    fuel_type: document.getElementById('v-fuel').value,
    colour: document.getElementById('v-colour').value,
    mileage: parseDistanceInput(document.getElementById('v-mileage').value),
    mot_due: document.getElementById('v-mot').value,
    service_due: document.getElementById('v-service').value,
    notes: document.getElementById('v-notes').value,
  };
  const savedVehicleId = await invoke('save_vehicle', { vehicle });
  mergeLocalVehicle(savedVehicleId, { ...vehicle, id: savedVehicleId });
  if (isNewVehicle) await recordVehicleCreatedForBilling();
  await syncAfterCloudMutation();
  closeModal(); toast(usedUnknownCustomer ? 'Vehicle saved under Unknown customer' : 'Vehicle saved'); render();
}

async function deleteVehicle(id) {
  const bookings = getVehicleBookings(id);
  const jobs = getVehicleJobs(id);
  if (jobs.length) {
    alert(`This vehicle is linked to ${jobs.length} job card${jobs.length === 1 ? '' : 's'}. Remove or reassign those jobs first.`);
    return;
  }
  if (bookings.length) {
    const bookingLabel = `${bookings.length} booking${bookings.length === 1 ? '' : 's'}`;
    if (!confirm(`This vehicle is in ${bookingLabel}. Delete the vehicle and those bookings from the calendar?`)) return;
  } else if (!confirm('Delete this vehicle?')) {
    return;
  }
  try {
    await invoke('delete_vehicle', { id, deleteBookings: bookings.length > 0 });
    await syncAfterCloudMutation();
    closeModal();
    toast(bookings.length ? 'Vehicle and bookings deleted' : 'Vehicle deleted');
    render();
  } catch (error) {
    alert(String(error));
  }
}

function showLegacyJobModal(jobId, presetClientId) {
  const j = jobId ? state.jobs.find(x=>x.id===jobId) : null;
  const initialClientId = j?.client_id || presetClientId || null;
  const initialVehicle = j?.vehicle_id ? getVehicleById(j.vehicle_id) : null;
  const initialMileage = getSyncedJobMileage(j, initialVehicle);
  showModal(`<div class="modal modal-wide">
    <h2>${j ? 'Edit Job Card' : 'New Job Card'}</h2>
    <div class="form-grid">
      <div class="form-row"><label>Customer *</label>
        <select id="j-client" onchange="filterVehiclesForClient(this.value)">
          <option value="">Select customer...</option>
          ${state.clients.map(c=>`<option value="${c.id}" ${(j?.client_id===c.id||presetClientId===c.id)?'selected':''}>${escHtml(c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>Vehicle *</label>
        <select id="j-vehicle" data-selected-vehicle-id="${j?.vehicle_id || ''}">
          <option value="">Select vehicle…</option>
          ${state.vehicles.map(v=>`<option value="${v.id}" ${j?.vehicle_id===v.id?'selected':''}>${escHtml(v.registration)} — ${escHtml(v.make)} ${escHtml(v.model)}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>Status</label>
        <select id="j-status">
          ${['New','Diagnosing','Waiting Parts','In Progress','Ready','Completed'].map(s=>`<option ${(j?.status||'New')===s?'selected':''}>${s}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>Mechanic</label><input id="j-mechanic" type="text" value="${escHtml(j?.mechanic||'')}" /></div>
      <div class="form-row"><label>${getDistanceInLabel()}</label><input id="j-mileage" type="number" value="${initialMileage}" /></div>
      <div class="form-row"><label>Est. completion</label><input id="j-estdate" type="date" value="${j?.est_completion||''}" /></div>
    </div>
    <div class="form-row"><label>Customer complaint</label><textarea id="j-complaint" rows="2">${escHtml(j?.complaint||'')}</textarea></div>
    <div class="form-row"><label>Initial findings</label><textarea id="j-findings" rows="2">${escHtml(j?.findings||'')}</textarea></div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveJob(${jobId||'null'})">Save</button>
    </div>
  </div>`);
  if (initialClientId) filterVehiclesForClient(initialClientId, j?.vehicle_id || null);
}

function normalizeJobModalOptions(optionsOrPresetClientId = null, presetVehicleId = null) {
  if (optionsOrPresetClientId && typeof optionsOrPresetClientId === 'object') {
    return {
      mode: optionsOrPresetClientId.mode || '',
      bookingId: optionsOrPresetClientId.bookingId || null,
      presetClientId: optionsOrPresetClientId.presetClientId || null,
      presetVehicleId: optionsOrPresetClientId.presetVehicleId || null,
    };
  }
  return {
    mode: '',
    bookingId: null,
    presetClientId: optionsOrPresetClientId || null,
    presetVehicleId: presetVehicleId || null,
  };
}

function getDefaultJobSourceBooking(bookingId = null) {
  const requested = bookingId ? getBookingById(parseInt(bookingId, 10)) : null;
  if (requested && requested.status !== 'Cancelled') return requested;
  const today = formatDateInputValue();
  const sourceBookings = getJobSourceBookings();
  const unlinked = sourceBookings.filter(booking => !getJobByBookingId(booking.id));
  return unlinked.find(booking => booking.date >= today) || unlinked[0] || sourceBookings.find(booking => booking.date >= today) || sourceBookings[0] || null;
}

function getJobBookingSearchText(booking) {
  return [
    booking.client_name,
    booking.registration,
    booking.make,
    booking.model,
    booking.reason,
    booking.status,
    fmtDate(booking.date),
    booking.time,
  ].join(' ').toLowerCase();
}

function isBookingInJobPickerRange(booking, range) {
  const today = formatDateInputValue();
  if (range === 'all') return true;
  if (range === 'today') return booking.date === today;
  if (range === 'week') {
    const weekEnd = formatDateInputValue(addDashboardDays(new Date(), 7));
    return booking.date >= today && booking.date <= weekEnd;
  }
  return booking.date >= today;
}

function getFilteredJobSourceBookings({ query = '', range = 'upcoming', linkedMode = 'unlinked' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const effectiveRange = q ? 'all' : range;
  const effectiveLinkedMode = q ? 'all' : linkedMode;
  const matches = getJobSourceBookings()
    .filter(booking => isBookingInJobPickerRange(booking, effectiveRange))
    .filter(booking => effectiveLinkedMode === 'all' || !getJobByBookingId(booking.id))
    .filter(booking => !q || getJobBookingSearchText(booking).includes(q));
  return {
    matches,
    visible: matches.slice(0, 4),
  };
}

function getJobBookingPickerState() {
  const query = document.getElementById('j-booking-search')?.value || '';
  return {
    query,
    range: document.getElementById('j-booking-filter-range')?.value || 'recommended',
    linkedMode: query.trim() ? 'all' : 'unlinked',
    selectedBookingId: parseInt(document.getElementById('j-booking-id')?.value || '', 10) || null,
  };
}

function renderJobBookingPickerCards({ query = '', range = 'recommended', linkedMode = 'unlinked', selectedBookingId = null } = {}) {
  const { matches, visible } = getFilteredJobSourceBookings({ query, range, linkedMode });
  const emptyCopy = query ? 'No bookings match this search.' : 'No bookings ready for a job card.';
  const meta = query
    ? `${matches.length} result${matches.length === 1 ? '' : 's'}`
    : `${matches.length} suggested booking${matches.length === 1 ? '' : 's'}`;
  return {
    meta: `${meta}${matches.length > visible.length ? `, showing ${visible.length}` : ''}`,
    html: visible.length ? visible.map(booking => {
      const linkedJob = getJobByBookingId(booking.id);
      const active = Number(selectedBookingId) === Number(booking.id);
      return `
        <button class="job-booking-card ${active ? 'active' : ''}" onclick="selectJobSourceBooking(${booking.id})" type="button">
          <div>
            <div class="job-booking-card-title">${escHtml(booking.client_name || 'Customer')} <span>${escHtml(booking.registration || 'Vehicle')}</span></div>
            <div class="job-booking-card-meta">${fmtDate(booking.date)} ${escHtml(booking.time || '')} &middot; ${escHtml(booking.reason || 'Workshop booking')}</div>
          </div>
          <div class="job-booking-card-side">
            ${linkedJob ? `<span class="badge badge-amber">Job #${linkedJob.id}</span>` : '<span class="badge badge-blue">Ready</span>'}
          </div>
        </button>
      `;
    }).join('') : `<div class="booking-empty compact">${emptyCopy}</div>`,
  };
}

function renderJobBookingPicker({ booking = null, query = '', range = 'recommended', linkedMode = 'unlinked' } = {}) {
  const selectedBookingId = booking?.id || null;
  const cards = renderJobBookingPickerCards({ query, range, linkedMode, selectedBookingId });
  return `
    <div id="j-booking-picker" class="job-booking-picker">
      <input id="j-booking-filter-linked" type="hidden" value="${escHtml(linkedMode)}" />
      <div class="job-booking-tools">
        <div class="form-row">
          <label>Find booking</label>
          <input id="j-booking-search" type="text" value="${escHtml(query)}" placeholder="Customer, reg, service..." oninput="refreshJobBookingPicker()" />
        </div>
        <div class="form-row job-booking-filter-row">
          <label>Show</label>
          <select id="j-booking-filter-range" onchange="updateJobBookingPickerFilter('range',this.value)">
            <option value="recommended" ${range === 'recommended' ? 'selected' : ''}>Suggested only</option>
            <option value="today" ${range === 'today' ? 'selected' : ''}>Today</option>
            <option value="week" ${range === 'week' ? 'selected' : ''}>This week</option>
            <option value="all" ${range === 'all' ? 'selected' : ''}>All active</option>
          </select>
        </div>
      </div>
      <div id="j-booking-meta" class="job-booking-meta">${escHtml(cards.meta)}</div>
      <div id="j-booking-results" class="job-booking-results">${cards.html}</div>
    </div>
  `;
}

function buildJobCustomerNotesFromBooking(booking) {
  if (!booking) return '';
  const parts = [`From booking: ${fmtDate(booking.date)} ${booking.time || ''}`.trim()];
  if (booking.notes) parts.push(booking.notes);
  return parts.join('\n');
}

function renderJobSourceBookingSummary(booking) {
  if (!booking) return '<span class="text-sm text-muted">Choose a booking to fill the job card.</span>';
  const linkedJob = getJobByBookingId(booking.id);
  return `
    <div>
      <strong>${escHtml(booking.client_name || 'Customer')}</strong>
      <div class="text-sm text-muted">${escHtml(booking.registration || 'Vehicle')} &middot; ${fmtDate(booking.date)} ${escHtml(booking.time || '')} &middot; ${escHtml(booking.reason || 'Workshop booking')}</div>
      ${booking.notes ? `<div class="text-sm text-muted" style="margin-top:4px">${escHtml(booking.notes)}</div>` : ''}
      ${linkedJob ? `<div class="text-sm" style="margin-top:6px;color:var(--amber-text)">Already linked to job #${linkedJob.id}.</div>` : ''}
    </div>
  `;
}

function renderJobSourcePanel({ mode, booking, sourceBookings }) {
  return `
    <div class="job-source-panel ${mode === 'direct' ? 'job-source-panel-compact' : ''}">
      <div class="job-source-head">
        <div>
          <div class="job-source-title">Job source</div>
        </div>
        <div class="segmented">
          <button class="btn btn-sm ${mode === 'direct' ? 'btn-primary' : ''}" onclick="showJobModal(null,{mode:'direct'})" type="button">Direct</button>
          <button class="btn btn-sm ${mode === 'booking' ? 'btn-primary' : ''}" onclick="showJobModal(null,{mode:'booking'})" type="button">From booking</button>
        </div>
      </div>
      ${mode === 'booking' ? `
        ${sourceBookings.length ? `
          ${renderJobBookingPicker({ booking })}
        ` : `
          <div class="booking-empty compact">No active bookings</div>
        `}
      ` : ''}
    </div>
  `;
}

function applyBookingToJobModal(bookingId) {
  const booking = getBookingById(parseInt(bookingId, 10));
  if (!booking) return;
  const bookingInput = document.getElementById('j-booking-id');
  if (bookingInput) bookingInput.value = String(booking.id);
  setJobClientSelection(booking.client_id, booking.vehicle_id);
  const complaintInput = document.getElementById('j-complaint');
  if (complaintInput && !complaintInput.dataset.userEdited) complaintInput.value = booking.reason || '';
  const notesInput = document.getElementById('j-customer-notes');
  if (notesInput && !notesInput.dataset.userEdited) notesInput.value = buildJobCustomerNotesFromBooking(booking);
  const summary = document.getElementById('j-source-booking-summary');
  if (summary) summary.innerHTML = renderJobSourceBookingSummary(booking);
  refreshJobBookingPicker();
}

function refreshJobBookingPicker() {
  const picker = document.getElementById('j-booking-picker');
  if (!picker) return;
  const pickerState = getJobBookingPickerState();
  const cards = renderJobBookingPickerCards(pickerState);
  const meta = document.getElementById('j-booking-meta');
  const results = document.getElementById('j-booking-results');
  if (meta) meta.textContent = cards.meta;
  if (results) results.innerHTML = cards.html;
}

function updateJobBookingPickerFilter(field, value) {
  if (field === 'range') {
    const rangeInput = document.getElementById('j-booking-filter-range');
    if (rangeInput) rangeInput.value = value;
  }
  if (field === 'linkedMode') {
    const linkedInput = document.getElementById('j-booking-filter-linked');
    if (linkedInput) linkedInput.value = value;
  }
  refreshJobBookingPicker();
}

function selectJobSourceBooking(bookingId) {
  applyBookingToJobModal(bookingId);
}

function getJobClientLabel(client) {
  if (!client) return '';
  return [client.name, client.phone, client.email].filter(Boolean).join(' - ');
}

function getJobVehicleLabel(vehicle) {
  if (!vehicle) return '';
  const makeModel = [vehicle.make, vehicle.model].filter(Boolean).join(' ').trim();
  return [vehicle.registration, makeModel].filter(Boolean).join(' - ');
}

function getJobClientSearchText(client) {
  const clientVehicles = state.vehicles.filter(vehicle => Number(vehicle.client_id) === Number(client.id));
  return [
    client.name,
    client.phone,
    client.email,
    client.company,
    ...clientVehicles.flatMap(vehicle => [vehicle.registration, vehicle.make, vehicle.model]),
  ].join(' ').toLowerCase();
}

function getJobVehicleSearchText(vehicle) {
  return [
    vehicle.registration,
    vehicle.make,
    vehicle.model,
    vehicle.client_name,
  ].join(' ').toLowerCase();
}

function getVehiclesForJobClient(clientId) {
  const cid = parseInt(clientId, 10);
  if (Number.isNaN(cid)) return [];
  return state.vehicles.filter(vehicle => Number(vehicle.client_id) === Number(cid));
}

function getJobClientMatches(query = '') {
  const q = String(query || '').trim();
  const clients = q
    ? state.clients.filter(client => typeaheadTextMatches(`${getJobClientLabel(client)} ${getJobClientSearchText(client)}`, q))
    : state.clients;
  return clients.slice(0, 8);
}

function getJobVehicleMatches(query = '', clientId = '') {
  const q = String(query || '').trim();
  const cid = parseInt(clientId, 10);
  if (Number.isNaN(cid) && !q) return [];
  const vehicles = Number.isNaN(cid)
    ? state.vehicles
    : getVehiclesForJobClient(cid);
  return (q ? vehicles.filter(vehicle => typeaheadTextMatches(`${getJobVehicleLabel(vehicle)} ${getJobVehicleSearchText(vehicle)}`, q)) : vehicles).slice(0, 8);
}

function getAllJobClientMatches(query = '') {
  const q = String(query || '').trim();
  return q ? state.clients.filter(client => typeaheadTextMatches(`${getJobClientLabel(client)} ${getJobClientSearchText(client)}`, q)) : state.clients;
}

function getAllJobVehicleMatches(query = '', clientId = '') {
  const q = String(query || '').trim();
  const cid = parseInt(clientId, 10);
  if (Number.isNaN(cid) && !q) return [];
  const vehicles = Number.isNaN(cid)
    ? state.vehicles
    : getVehiclesForJobClient(cid);
  return q ? vehicles.filter(vehicle => typeaheadTextMatches(`${getJobVehicleLabel(vehicle)} ${getJobVehicleSearchText(vehicle)}`, q)) : vehicles;
}

function normalizeJobTypeaheadText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function typeaheadTextMatches(candidateText, queryText) {
  const candidate = normalizeJobTypeaheadText(candidateText);
  const query = normalizeJobTypeaheadText(queryText);
  if (!query) return false;
  if (candidate === query || candidate.includes(query)) return true;
  const tokens = query.split(' ').filter(Boolean);
  return tokens.length > 0 && tokens.every(token => candidate.includes(token));
}

function getJobClientAutoMatch(query = '') {
  const normalized = normalizeJobTypeaheadText(query);
  if (normalized.length < 3) return null;
  const matches = getAllJobClientMatches(query);
  return matches.find(client => normalizeJobTypeaheadText(getJobClientLabel(client)) === normalized)
    || (matches.length === 1 ? matches[0] : null);
}

function getJobVehicleAutoMatch(query = '', clientId = '') {
  const normalized = normalizeJobTypeaheadText(query);
  if (normalized.length < 3) return null;
  const matches = getAllJobVehicleMatches(query, clientId);
  return matches.find(vehicle => (
    normalizeJobTypeaheadText(vehicle.registration) === normalized
    || normalizeJobTypeaheadText(getJobVehicleLabel(vehicle)) === normalized
  )) || (matches.length === 1 ? matches[0] : null);
}

function getJobClientFromInputValue(value = '', selectedClientId = '') {
  const normalized = normalizeJobTypeaheadText(value);
  if (!normalized) return null;
  const selectedClient = state.clients.find(client => Number(client.id) === Number(selectedClientId));
  if (selectedClient) {
    const selectedLabel = normalizeJobTypeaheadText(getJobClientLabel(selectedClient));
    if (selectedLabel && normalized.startsWith(selectedLabel)) return selectedClient;
  }
  return state.clients.find(client => {
    const label = normalizeJobTypeaheadText(getJobClientLabel(client));
    return label && normalized.startsWith(label);
  }) || getJobClientAutoMatch(value);
}

function resolveJobClientFromInput() {
  const clientInput = document.getElementById('j-client');
  const selectedId = parseInt(clientInput?.value || '', 10);
  const selectedClient = state.clients.find(client => Number(client.id) === Number(selectedId));
  if (selectedClient) return selectedClient;
  const searchValue = document.getElementById('j-client-search')?.value || '';
  const matchedClient = getJobClientFromInputValue(searchValue, clientInput?.value || '')
    || state.clients.find(client => typeaheadTextMatches(`${getJobClientLabel(client)} ${getJobClientSearchText(client)}`, searchValue));
  if (matchedClient && clientInput) clientInput.value = String(matchedClient.id);
  return matchedClient || null;
}

function resolveJobVehicleFromInput(clientId = null) {
  const vehicleInput = document.getElementById('j-vehicle');
  const selectedId = parseInt(vehicleInput?.value || '', 10);
  const cid = parseInt(clientId, 10);
  const hasClient = !Number.isNaN(cid);
  const selectedVehicle = state.vehicles.find(vehicle => Number(vehicle.id) === Number(selectedId));
  if (selectedVehicle && (!hasClient || Number(selectedVehicle.client_id) === Number(cid))) return selectedVehicle;
  const searchValue = document.getElementById('j-vehicle-search')?.value || '';
  const vehicles = hasClient ? getVehiclesForJobClient(cid) : state.vehicles;
  const matchedVehicle = vehicles.find(vehicle => typeaheadTextMatches(`${getJobVehicleLabel(vehicle)} ${getJobVehicleSearchText(vehicle)}`, searchValue));
  if (matchedVehicle && vehicleInput) vehicleInput.value = String(matchedVehicle.id);
  const vehicleSearch = document.getElementById('j-vehicle-search');
  if (matchedVehicle && vehicleSearch) vehicleSearch.dataset.selectedVehicleId = String(matchedVehicle.id);
  return matchedVehicle || null;
}

function renderJobClientTypeaheadResults(query = '', selectedClientId = '') {
  let matches = getJobClientMatches(query);
  if (!matches.length) {
    const retainedClient = getJobClientFromInputValue(query, selectedClientId);
    if (retainedClient) matches = [retainedClient];
  }
  if (!matches.length) return '<div class="typeahead-empty">No customers match this search</div>';
  return matches.map(client => {
    const active = String(client.id) === String(selectedClientId);
    const clientVehicles = getVehiclesForJobClient(client.id);
    const matchingVehicles = String(query || '').trim()
      ? clientVehicles.filter(vehicle => typeaheadTextMatches(`${getJobVehicleLabel(vehicle)} ${getJobVehicleSearchText(vehicle)}`, query))
      : [];
    const vehicleHint = matchingVehicles.length
      ? matchingVehicles.slice(0, 2).map(getJobVehicleLabel).join(', ')
      : `${clientVehicles.length} vehicle${clientVehicles.length === 1 ? '' : 's'}`;
    return `
      <button type="button" class="typeahead-option ${active ? 'active' : ''}" onclick="setJobClientSelection(${client.id}, null, true)">
        <span class="typeahead-title">${escHtml(client.name || 'Customer')}</span>
        <span class="typeahead-meta">${escHtml([client.phone || 'No phone', client.email || 'No email', vehicleHint].join(' - '))}</span>
      </button>
    `;
  }).join('');
}

function renderJobVehicleTypeaheadResults(query = '', clientId = '', selectedVehicleId = '') {
  const matches = getJobVehicleMatches(getJobVehiclePickerQuery(query, clientId, selectedVehicleId), clientId);
  if (!matches.length) {
    const hasClient = !Number.isNaN(parseInt(clientId, 10));
    if (!hasClient && !String(query || '').trim()) {
      return '<div class="typeahead-empty">Select a customer first, or search by registration</div>';
    }
    if (hasClient) {
      return '<div class="typeahead-empty">No vehicles for this customer match this search</div>';
    }
    return '<div class="typeahead-empty">No vehicles match this search</div>';
  }
  return matches.map(vehicle => {
    const active = String(vehicle.id) === String(selectedVehicleId);
    return `
      <button type="button" class="typeahead-option ${active ? 'active' : ''}" onclick="setJobVehicleSelection(${vehicle.id})">
        <span class="typeahead-title">${escHtml(vehicle.registration || 'Vehicle')}</span>
        <span class="typeahead-meta">${escHtml([vehicle.client_name, [vehicle.make, vehicle.model].filter(Boolean).join(' ').trim()].filter(Boolean).join(' - ') || 'Vehicle details')}</span>
      </button>
    `;
  }).join('');
}

function getJobVehicleOwner(vehicle) {
  return state.clients.find(client => Number(client.id) === Number(vehicle?.client_id)) || null;
}

function getJobVehiclePickerQuery(query = '', clientId = '', selectedVehicleId = '') {
  const hasClient = !Number.isNaN(parseInt(clientId, 10));
  const trimmedQuery = String(query || '').trim();
  if (!hasClient) return trimmedQuery;
  const normalizedQuery = normalizeJobTypeaheadText(query);
  if (!normalizedQuery) return '';
  const selectedVehicle = state.vehicles.find(vehicle => String(vehicle.id) === String(selectedVehicleId));
  const vehiclesToCheck = selectedVehicle ? [selectedVehicle] : getVehiclesForJobClient(clientId);
  const isSelectedDisplayText = vehiclesToCheck.some(vehicle => {
    const selectedLabel = normalizeJobTypeaheadText(getJobVehicleLabel(vehicle));
    const selectedRegistration = normalizeJobTypeaheadText(vehicle.registration);
    return normalizedQuery === selectedLabel || (selectedVehicle && normalizedQuery === selectedRegistration);
  });
  if (isSelectedDisplayText) {
    return '';
  }
  return trimmedQuery;
}

function renderJobClientPickerResults(query = '', selectedClientId = '') {
  let matches = getJobClientMatches(query);
  if (!matches.length) {
    const retainedClient = getJobClientFromInputValue(query, selectedClientId);
    if (retainedClient) matches = [retainedClient];
  }
  if (!matches.length) return '<div class="job-picker-empty">No customers match this search</div>';
  return matches.map(client => {
    const active = String(client.id) === String(selectedClientId);
    const clientVehicles = getVehiclesForJobClient(client.id);
    const vehicleHint = `${clientVehicles.length} vehicle${clientVehicles.length === 1 ? '' : 's'}`;
    return `
      <button type="button" class="job-picker-option ${active ? 'active' : ''}" onclick="setJobClientSelection(${client.id}, null, true)">
        <span class="job-picker-title">${escHtml(client.name || 'Customer')}</span>
        <span class="job-picker-meta">${escHtml([client.phone || 'No phone', client.email || 'No email', vehicleHint].join(' - '))}</span>
      </button>
    `;
  }).join('');
}

function renderJobVehiclePickerResults(query = '', clientId = '', selectedVehicleId = '', allowGlobalSearch = true) {
  const q = getJobVehiclePickerQuery(query, clientId, selectedVehicleId);
  const hasClient = !Number.isNaN(parseInt(clientId, 10));
  const matches = hasClient ? getJobVehicleMatches(q, clientId) : (allowGlobalSearch && q ? getJobVehicleMatches(q, '') : []);
  if (!matches.length) {
    if (hasClient) return '<div class="job-picker-empty">No vehicles for this customer match this search</div>';
    if (!allowGlobalSearch) return '<div class="job-picker-empty">Select a customer from the left column first</div>';
    return '<div class="job-picker-empty">Search registration to find the vehicle owner</div>';
  }
  return matches.map(vehicle => {
    const active = String(vehicle.id) === String(selectedVehicleId);
    const owner = getJobVehicleOwner(vehicle);
    const vehicleMeta = hasClient
      ? [vehicle.vin ? `VIN ${vehicle.vin}` : '', vehicle.mileage ? `${fmtDistance(vehicle.mileage)}` : '', vehicle.mot_due ? `MOT ${fmtDate(vehicle.mot_due)}` : ''].filter(Boolean).join(' - ')
      : [owner?.name || vehicle.client_name || 'Unknown customer', owner?.phone || 'No phone'].filter(Boolean).join(' - ');
    return `
      <button type="button" class="job-picker-option ${active ? 'active' : ''}" onclick="setJobVehicleSelection(${vehicle.id})">
        <span class="job-picker-title">${escHtml(getJobVehicleLabel(vehicle) || 'Vehicle')}</span>
        <span class="job-picker-meta">${escHtml(vehicleMeta || 'Vehicle details')}</span>
      </button>
    `;
  }).join('');
}

function renderJobDirectPicker({ initialClientId = '', initialVehicleId = '' } = {}) {
  const selectedClient = initialClientId
    ? state.clients.find(client => Number(client.id) === Number(initialClientId))
    : null;
  const selectedVehicle = initialVehicleId
    ? state.vehicles.find(vehicle => Number(vehicle.id) === Number(initialVehicleId))
    : null;
  const clientVehicleCount = selectedClient ? getVehiclesForJobClient(selectedClient.id).length : 0;
  const vehicleTitle = selectedClient ? `Vehicles for ${selectedClient.name || 'customer'}` : 'Vehicle';
  const vehicleBadge = selectedClient
    ? `${clientVehicleCount} vehicle${clientVehicleCount === 1 ? '' : 's'}`
    : 'Search reg';
  return `
    <div class="job-direct-picker-shell">
      <div class="job-direct-picker">
        <div class="job-picker-column">
          <div class="job-picker-column-head">
            <div>
              <label for="j-client-search">Customer *</label>
              <div class="job-picker-subtitle">${selectedClient ? escHtml(selectedClient.phone || selectedClient.email || 'Customer selected') : 'Name, phone, email or reg'}</div>
            </div>
            <span id="j-client-count" class="job-picker-badge">${selectedClient ? `${clientVehicleCount} vehicle${clientVehicleCount === 1 ? '' : 's'}` : `${state.clients.length} customers`}</span>
          </div>
          <input id="j-client-search" class="job-picker-search-input" type="text" autocomplete="off" value="${escHtml(getJobClientLabel(selectedClient))}" placeholder="Search customer..." oninput="updateJobClientSearch(this.value)" onfocus="refreshJobDirectPicker()" />
          <div id="j-client-results" class="job-picker-results">${renderJobClientPickerResults('', initialClientId || '')}</div>
        </div>
        <div class="job-picker-column">
          <div class="job-picker-column-head">
            <div>
              <label for="j-vehicle-search">${escHtml(vehicleTitle)} *</label>
              <div id="j-vehicle-subtitle" class="job-picker-subtitle">${selectedVehicle ? escHtml(getJobVehicleLabel(selectedVehicle)) : (selectedClient ? 'Customer vehicles' : 'Registration search')}</div>
            </div>
            <span id="j-vehicle-count" class="job-picker-badge">${escHtml(vehicleBadge)}</span>
          </div>
          <input id="j-vehicle-search" class="job-picker-search-input" type="text" autocomplete="off" value="${escHtml(getJobVehicleLabel(selectedVehicle))}" data-selected-vehicle-id="${initialVehicleId || ''}" placeholder="${selectedClient ? 'Filter this customer vehicles...' : 'Search registration...'}" oninput="updateJobVehicleSearch(this.value)" onfocus="refreshJobDirectPicker()" />
          <div id="j-vehicle-results" class="job-picker-results">${renderJobVehiclePickerResults('', initialClientId || '', initialVehicleId || '', true)}</div>
        </div>
      </div>
    </div>
  `;
}

function refreshJobDirectPicker() {
  const clientInput = document.getElementById('j-client');
  const vehicleInput = document.getElementById('j-vehicle');
  const clientSearch = document.getElementById('j-client-search');
  const vehicleSearch = document.getElementById('j-vehicle-search');
  const clientResults = document.getElementById('j-client-results');
  const vehicleResults = document.getElementById('j-vehicle-results');
  const clientCount = document.getElementById('j-client-count');
  const vehicleCount = document.getElementById('j-vehicle-count');
  const vehicleSubtitle = document.getElementById('j-vehicle-subtitle');
  if (!clientSearch || !vehicleSearch || !clientResults || !vehicleResults) return;
  const selectedClient = clientInput?.value
    ? state.clients.find(client => Number(client.id) === Number(clientInput.value))
    : null;
  const typedClient = getJobClientFromInputValue(clientSearch.value, clientInput?.value || '');
  const effectiveClient = selectedClient || typedClient;
  const selectedClientId = effectiveClient?.id || '';
  const selectedVehicleId = vehicleInput?.value || '';
  if (effectiveClient && clientInput) clientInput.value = String(effectiveClient.id);
  clientResults.innerHTML = renderJobClientPickerResults(clientSearch.value, selectedClientId);
  const allowGlobalVehicleSearch = !selectedClientId && !String(clientSearch.value || '').trim();
  vehicleResults.innerHTML = renderJobVehiclePickerResults(vehicleSearch.value, selectedClientId, selectedVehicleId, allowGlobalVehicleSearch);
  const clientVehicleCount = selectedClientId ? getVehiclesForJobClient(selectedClientId).length : 0;
  if (clientCount) {
    clientCount.textContent = selectedClientId
      ? `${clientVehicleCount} vehicle${clientVehicleCount === 1 ? '' : 's'}`
      : `${state.clients.length} customers`;
  }
  if (vehicleCount) {
    vehicleCount.textContent = selectedClientId
      ? `${clientVehicleCount} vehicle${clientVehicleCount === 1 ? '' : 's'}`
      : 'Search reg';
  }
  if (vehicleSubtitle) {
    const selectedVehicle = selectedVehicleId ? state.vehicles.find(vehicle => Number(vehicle.id) === Number(selectedVehicleId)) : null;
    vehicleSubtitle.textContent = selectedVehicle
      ? getJobVehicleLabel(selectedVehicle)
      : (effectiveClient ? 'Customer vehicles' : 'Registration search');
  }
  vehicleSearch.placeholder = selectedClientId ? 'Filter this customer vehicles...' : 'Search registration...';
}

function refreshJobClientTypeahead() {
  refreshJobDirectPicker();
}

function refreshJobVehicleTypeahead() {
  refreshJobDirectPicker();
}

function setJobVehicleChoiceOpen(open) {
  const vehicleSearch = document.getElementById('j-vehicle-search');
  const typeahead = vehicleSearch?.closest('.typeahead');
  if (typeahead) typeahead.classList.toggle('force-open', Boolean(open));
}

function syncJobMileageInputFromVehicle(vehicle, { force = false } = {}) {
  const mileageInput = document.getElementById('j-mileage');
  const vehicleMileage = parseDistanceInput(vehicle?.mileage, 0);
  if (!mileageInput || vehicleMileage <= 0) return;
  const currentMileage = parseDistanceInput(mileageInput.value, 0);
  if (force || currentMileage <= 0) mileageInput.value = String(vehicleMileage);
}

function setJobClientSelection(clientId, preferredVehicleId = null, focusVehicle = false) {
  const client = state.clients.find(item => Number(item.id) === Number(clientId));
  const clientInput = document.getElementById('j-client');
  const clientSearch = document.getElementById('j-client-search');
  if (!client || !clientInput || !clientSearch) return;
  clientInput.value = String(client.id);
  clientSearch.value = getJobClientLabel(client);
  if (!preferredVehicleId) {
    const vehicleInput = document.getElementById('j-vehicle');
    const vehicleSearch = document.getElementById('j-vehicle-search');
    if (vehicleInput) vehicleInput.value = '';
    if (vehicleSearch) {
      vehicleSearch.value = '';
      vehicleSearch.dataset.selectedVehicleId = '';
    }
  }
  filterVehiclesForClient(client.id, preferredVehicleId);
  if (focusVehicle && !preferredVehicleId && getVehiclesForJobClient(client.id).length > 1) {
    document.getElementById('j-vehicle-search')?.focus();
  }
  refreshJobDirectPicker();
}

function setJobVehicleSelection(vehicleId) {
  const vehicle = state.vehicles.find(item => Number(item.id) === Number(vehicleId));
  const vehicleInput = document.getElementById('j-vehicle');
  const vehicleSearch = document.getElementById('j-vehicle-search');
  if (!vehicle || !vehicleInput || !vehicleSearch) return;
  const owner = state.clients.find(item => Number(item.id) === Number(vehicle.client_id));
  if (owner) {
    const clientInput = document.getElementById('j-client');
    const clientSearch = document.getElementById('j-client-search');
    if (clientInput) clientInput.value = String(owner.id);
    if (clientSearch) clientSearch.value = getJobClientLabel(owner);
  }
  vehicleInput.value = String(vehicle.id);
  vehicleSearch.value = getJobVehicleLabel(vehicle);
  vehicleSearch.dataset.selectedVehicleId = String(vehicle.id);
  setJobVehicleChoiceOpen(false);
  syncJobMileageInputFromVehicle(vehicle);
  refreshJobDirectPicker();
}

function updateJobClientSearch(value) {
  const clientInput = document.getElementById('j-client');
  const vehicleInput = document.getElementById('j-vehicle');
  const vehicleSearch = document.getElementById('j-vehicle-search');
  if (clientInput) clientInput.value = '';
  if (vehicleInput) vehicleInput.value = '';
  if (vehicleSearch) {
    vehicleSearch.value = '';
    vehicleSearch.dataset.selectedVehicleId = '';
  }
  setJobVehicleChoiceOpen(false);
  refreshJobDirectPicker();
}

function updateJobVehicleSearch(value = '') {
  const vehicleInput = document.getElementById('j-vehicle');
  const vehicleSearch = document.getElementById('j-vehicle-search');
  if (vehicleInput) vehicleInput.value = '';
  if (vehicleSearch) vehicleSearch.dataset.selectedVehicleId = '';
  setJobVehicleChoiceOpen(false);
  refreshJobDirectPicker();
}

function showJobModal(jobId = null, optionsOrPresetClientId = null, presetVehicleId = null) {
  const j = jobId ? state.jobs.find(x=>x.id===jobId) : null;
  const options = normalizeJobModalOptions(optionsOrPresetClientId, presetVehicleId);
  const sourceBookings = getJobSourceBookings();
  const sourceBooking = j?.booking_id ? getBookingById(j.booking_id) : getDefaultJobSourceBooking(options.bookingId);
  const mode = j ? (j.booking_id ? 'booking' : 'direct') : (options.mode || (options.bookingId ? 'booking' : 'direct'));
  const booking = mode === 'booking' ? sourceBooking : null;
  const initialClientId = j?.client_id || booking?.client_id || options.presetClientId || null;
  const initialVehicleId = j?.vehicle_id || booking?.vehicle_id || options.presetVehicleId || null;
  const initialComplaint = j?.complaint || booking?.reason || '';
  const initialCustomerNotes = j?.customer_notes || buildJobCustomerNotesFromBooking(booking);
  const initialClient = initialClientId ? state.clients.find(client => Number(client.id) === Number(initialClientId)) : null;
  const initialVehicle = initialVehicleId ? state.vehicles.find(vehicle => Number(vehicle.id) === Number(initialVehicleId)) : null;
  const initialMileage = getSyncedJobMileage(j, initialVehicle);
  showModal(`<div class="modal modal-wide">
    <h2>${j ? 'Edit Job Card' : 'New Job Card'}</h2>
    ${j ? (j.booking_id ? `<div class="job-source-panel"><div class="job-source-title">From booking</div><div class="text-sm text-muted">${fmtDate(j.booking_date)} ${escHtml(j.booking_time || '')} &middot; ${escHtml(j.booking_reason || '')}</div></div>` : '') : renderJobSourcePanel({ mode, booking, sourceBookings })}
    <input id="j-booking-id" type="hidden" value="${j?.booking_id || booking?.id || ''}" />
    <input id="j-client" type="hidden" value="${initialClientId || ''}" />
    <input id="j-vehicle" type="hidden" value="${initialVehicleId || ''}" />
    ${renderJobDirectPicker({ initialClientId: initialClientId || '', initialVehicleId: initialVehicleId || '' })}
    <div class="form-grid">
      <div class="form-row"><label>Status</label>
        <select id="j-status">
          ${['New','Diagnosing','Waiting Parts','In Progress','Ready','Completed'].map(s=>`<option ${(j?.status||'New')===s?'selected':''}>${s}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>Mechanic</label><input id="j-mechanic" type="text" value="${escHtml(j?.mechanic||'')}" /></div>
      <div class="form-row"><label>${getDistanceInLabel()}</label><input id="j-mileage" type="number" value="${initialMileage}" /></div>
      <div class="form-row"><label>Est. completion</label><input id="j-estdate" type="date" value="${j?.est_completion||''}" /></div>
    </div>
    <div class="form-row"><label>Customer complaint</label><textarea id="j-complaint" rows="2" oninput="this.dataset.userEdited='1'">${escHtml(initialComplaint)}</textarea></div>
    <div class="form-row"><label>Initial findings</label><textarea id="j-findings" rows="2">${escHtml(j?.findings||'')}</textarea></div>
    <textarea id="j-customer-notes" style="display:none" oninput="this.dataset.userEdited='1'">${escHtml(initialCustomerNotes)}</textarea>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveJob(${jobId||'null'})">${j ? 'Save' : 'Create job card'}</button>
    </div>
  </div>`);
  if (initialClientId) filterVehiclesForClient(initialClientId, initialVehicleId || null);
}

function filterVehiclesForClient(clientId, selectedVehicleId) {
  const sel = document.getElementById('j-vehicle');
  if (!sel) return;
  const cid = parseInt(clientId);
  const filtered = isNaN(cid) ? [] : getVehiclesForJobClient(cid);
  const explicitPreferred = selectedVehicleId !== null && selectedVehicleId !== undefined && String(selectedVehicleId) !== '';
  if (sel.tagName === 'SELECT') {
    sel.innerHTML = '<option value="">Select vehicle…</option>' + filtered.map(v=>`<option value="${v.id}">${escHtml(v.registration)} — ${escHtml(v.make)} ${escHtml(v.model)}</option>`).join('');
  }
  const preferredVehicleId = explicitPreferred ? selectedVehicleId : null;
  if (preferredVehicleId && filtered.some(v => String(v.id) === String(preferredVehicleId))) {
    sel.value = String(preferredVehicleId);
  } else if (sel.tagName === 'SELECT' && filtered.length === 1) {
    sel.value = String(filtered[0].id);
  } else {
    sel.value = '';
  }
  const selectedVehicle = state.vehicles.find(v => String(v.id) === String(sel.value));
  if (selectedVehicle) syncJobMileageInputFromVehicle(selectedVehicle);
  if (sel.tagName !== 'SELECT') {
    const vehicleSearch = document.getElementById('j-vehicle-search');
    if (vehicleSearch) {
      vehicleSearch.value = getJobVehicleLabel(selectedVehicle);
      vehicleSearch.dataset.selectedVehicleId = sel.value;
      vehicleSearch.placeholder = !selectedVehicle && filtered.length > 1
        ? `Choose one of ${filtered.length} vehicles...`
        : 'Select customer first, or type registration...';
    }
    setJobVehicleChoiceOpen(!selectedVehicle && filtered.length > 1);
    refreshJobDirectPicker();
  }
}

async function saveJob(jobId) {
  const existingJob = jobId ? state.jobs.find(j => j.id === jobId) : null;
  let client = resolveJobClientFromInput();
  let vehicle = resolveJobVehicleFromInput(client?.id || null);
  if (vehicle && (!client || Number(client.id) !== Number(vehicle.client_id))) {
    const owner = state.clients.find(item => Number(item.id) === Number(vehicle.client_id));
    if (owner) {
      client = owner;
      const clientInput = document.getElementById('j-client');
      if (clientInput) clientInput.value = String(owner.id);
      const clientSearch = document.getElementById('j-client-search');
      if (clientSearch) clientSearch.value = getJobClientLabel(owner);
    }
  }
  const clientId = Number(client?.id || 0);
  const vehicleId = Number(vehicle?.id || 0);
  const bookingId = parseInt(document.getElementById('j-booking-id')?.value || '', 10) || null;
  if (!clientId || !vehicleId) { alert('Select customer and vehicle'); return; }
  const linkedJob = bookingId ? getJobByBookingId(bookingId) : null;
  if (linkedJob && Number(linkedJob.id) !== Number(jobId || 0)) {
    closeModal();
    toast(`Opened existing job #${linkedJob.id} for this booking`);
    state.selectedJob = linkedJob.id;
    state.screen = 'jobs';
    await render();
    return;
  }
  if (!existingJob && !(await ensureJobCardCreationAllowed())) return;
  const mileageIn = parseDistanceInput(document.getElementById('j-mileage').value, getSyncedJobMileage(existingJob, vehicle));
  const job = {
    id: jobId || null, client_id: clientId, vehicle_id: vehicleId,
    booking_id: bookingId,
    status: document.getElementById('j-status').value,
    complaint: document.getElementById('j-complaint').value,
    findings: document.getElementById('j-findings').value,
    work_performed: existingJob?.work_performed || '', mechanic: document.getElementById('j-mechanic').value,
    mileage_in: mileageIn,
    mileage_out: existingJob?.mileage_out || 0, est_completion: document.getElementById('j-estdate').value,
    internal_notes: existingJob?.internal_notes || '', customer_notes: document.getElementById('j-customer-notes')?.value || existingJob?.customer_notes || '', date_opened: '',
  };
  const id = await invoke('save_job_card', { job });
  await syncAfterCloudMutation();
  closeModal(); toast(bookingId ? 'Job created from booking' : 'Job saved');
  state.selectedJob = id;
  state.screen = 'jobs';
  await render();
}

function resolveBookingModalClientId(booking) {
  const vehicleOwnerId = booking?.vehicle_id ? state.vehicles.find(v => v.id === booking.vehicle_id)?.client_id : null;
  return vehicleOwnerId || booking?.client_id || state.clients[0]?.id || '';
}

function renderBookingModalVehicleOptions(clientId, selectedVehicleId) {
  const cid = parseInt(clientId, 10);
  const vehicles = Number.isNaN(cid) ? [] : state.vehicles.filter(v => v.client_id === cid);
  const selected = vehicles.some(v => String(v.id) === String(selectedVehicleId))
    ? String(selectedVehicleId)
    : (vehicles[0] ? String(vehicles[0].id) : '');
  return {
    selectedVehicleId: selected,
    optionsHtml: vehicles.length
      ? vehicles.map(v => `<option value="${v.id}" ${selected === String(v.id) ? 'selected' : ''}>${escHtml(v.registration)} — ${escHtml(v.make)} ${escHtml(v.model)}</option>`).join('')
      : '<option value="">No vehicles for this client</option>',
  };
}

function syncBookingModalVehicleOptions(clientId, selectedVehicleId) {
  const clientSelect = document.getElementById('b-client');
  const vehicleSelect = document.getElementById('b-vehicle');
  if (!clientSelect || !vehicleSelect) return;
  const normalizedClientId = String(clientId || '');
  clientSelect.value = normalizedClientId;
  const next = renderBookingModalVehicleOptions(normalizedClientId, selectedVehicleId);
  vehicleSelect.innerHTML = next.optionsHtml;
  vehicleSelect.value = next.selectedVehicleId;
}

function handleBookingModalClientChange(clientId) {
  syncBookingModalVehicleOptions(clientId, null);
}

function handleBookingModalVehicleChange(vehicleId) {
  const vehicle = state.vehicles.find(v => String(v.id) === String(vehicleId));
  if (!vehicle) return;
  syncBookingModalVehicleOptions(vehicle.client_id, vehicle.id);
}

function syncBookingModalTimeOptions(dateValue, { preserveSelected = false } = {}) {
  const timeSelect = document.getElementById('b-time');
  if (!timeSelect) return;
  const currentValue = timeSelect.value || '';
  const nextOptions = getFilteredBookingTimeOptions(dateValue, currentValue, { preserveSelected });
  timeSelect.innerHTML = renderBookingTimeOptions(nextOptions, currentValue);
  if (nextOptions.includes(currentValue)) {
    timeSelect.value = currentValue;
  } else {
    timeSelect.value = nextOptions[0] || '';
  }
}

function handleBookingModalDateChange(dateValue) {
  syncBookingModalTimeOptions(dateValue, { preserveSelected: false });
}

function showBookingModal(bookingId) {
  const b = bookingId ? state.bookings.find(x=>x.id===bookingId) : null;
  const today = formatDateInputValue();
  const initialClientId = resolveBookingModalClientId(b);
  const initialVehicle = b?.vehicle_id ? state.vehicles.find(v => v.id === b.vehicle_id) : null;
  const timeOptions = getFilteredBookingTimeOptions(b?.date || today, b?.time || '', { preserveSelected: true });
  const vehicleOptions = renderBookingModalVehicleOptions(initialClientId, initialVehicle?.id || null);
  const bookingSmsEntry = b ? (state.messageLog || []).find(entry => (
    normalizeMessageCategoryKey(entry.category) === 'booking_confirmation'
    && (Number(entry.booking_id ?? entry.bookingId ?? 0) === Number(b.id) || (getMessageLogRelatedType(entry) === 'booking' && getMessageLogRelatedId(entry) === Number(b.id)))
  )) : null;
  showModal(`<div class="modal">
    <h2>${b ? 'Edit Booking' : 'New Booking'}</h2>
    <div class="form-grid">
      <div class="form-row"><label>Customer</label>
        <select id="b-client" onchange="handleBookingModalClientChange(this.value)">
          ${state.clients.map(c=>`<option value="${c.id}" ${String(initialClientId)===String(c.id)?'selected':''}>${escHtml(c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>Vehicle</label>
        <select id="b-vehicle" onchange="handleBookingModalVehicleChange(this.value)">
          ${vehicleOptions.optionsHtml}
        </select>
      </div>
      <div class="form-row"><label>Date</label><input id="b-date" type="date" value="${b?.date||today}" onchange="handleBookingModalDateChange(this.value)" /></div>
      <div class="form-row"><label>Time</label>
        <select id="b-time">
          ${renderBookingTimeOptions(timeOptions, b?.time || '')}
        </select>
      </div>
      <div class="form-row"><label>Reason</label><input id="b-reason" type="text" value="${escHtml(b?.reason||'')}" /></div>
      <div class="form-row"><label>Status</label>
        <select id="b-status">
          ${['Pending','Confirmed','Cancelled'].map(s=>`<option ${(b?.status||'Pending')===s?'selected':''}>${s}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-row"><label>Notes</label><textarea id="b-notes">${escHtml(b?.notes||'')}</textarea></div>
    ${b ? `<div class="message-action-meta" style="margin-top:10px">${bookingSmsEntry ? StatusBadge(bookingSmsEntry.status || 'Draft') : renderPill('Not sent', 'gray')}<span class="entity-subtitle">Booking SMS</span></div>` : ''}
    <div class="modal-footer">
      ${b ? (b.status !== 'Cancelled'
        ? `<button class="btn btn-danger btn-sm" onclick="cancelBooking(${b.id}, true)">Cancel booking</button><span style="flex:1"></span>`
        : `<button class="btn btn-sm" onclick="restoreBooking(${b.id}, true)">Restore booking</button><span style="flex:1"></span>`) : ''}
      ${b ? renderBookingJobAction(b) : ''}
      ${b ? `<button class="btn" onclick="showBookingSmsModal(${b.id})">Send booking SMS</button>` : ''}
      ${b ? `<button class="btn btn-danger btn-sm" onclick="deleteBooking(${b.id}, true)">Delete booking</button>` : ''}
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveBooking(${bookingId||'null'})">Save</button>
    </div>
  </div>`);
  syncBookingModalVehicleOptions(initialClientId, vehicleOptions.selectedVehicleId);
}

async function saveBooking(bookingId) {
  const clientId = parseInt(document.getElementById('b-client').value)||0;
  const vehicleId = parseInt(document.getElementById('b-vehicle').value)||0;
  const existingBooking = bookingId ? getBookingById(bookingId) : null;
  if (!clientId) { alert('Select a client'); return; }
  if (!vehicleId) { alert('Select a vehicle'); return; }
  const booking = {
    id: bookingId || null,
    client_id: clientId,
    vehicle_id: vehicleId,
    date: document.getElementById('b-date').value,
    time: document.getElementById('b-time').value,
    reason: document.getElementById('b-reason').value,
    status: document.getElementById('b-status').value,
    notes: document.getElementById('b-notes').value,
  };
  if (!booking.date || !booking.time) { alert('Choose a date and time'); return; }
  const timeChangeBlocked = !canBookTime(booking.date, booking.time)
    && (!existingBooking || existingBooking.date !== booking.date || existingBooking.time !== booking.time);
  if (timeChangeBlocked) {
    alert('This time has already passed. Turn on Past times in the calendar or choose another slot.');
    return;
  }
  if (!existingBooking && !(await ensureBookingCreationAllowed(booking.date))) return;
  const savedBookingId = await invoke('save_booking', { booking });
  if (!existingBooking) {
    const client = getClientById(clientId);
    const vehicle = getVehicleById(vehicleId);
    await sendAutomaticBookingSms({ ...booking, id: savedBookingId, client_name: client?.name || '', registration: vehicle?.registration || '' }, client, vehicle);
  }
  await syncAfterCloudMutation();
  closeModal(); toast('Booking saved'); render();
}

async function updateBookingStatus(bookingId, status, closeAfter = false) {
  const booking = getBookingById(bookingId);
  if (!booking) return;
  await invoke('save_booking', {
    booking: {
      ...booking,
      id: bookingId,
      status,
    }
  });
  await syncAfterCloudMutation();
  if (closeAfter) closeModal();
  toast(status === 'Cancelled' ? 'Booking cancelled' : `Booking ${status.toLowerCase()}`);
  await render();
}

async function cancelBooking(bookingId, closeAfter = false) {
  const booking = getBookingById(bookingId);
  if (!booking || booking.status === 'Cancelled') return;
  if (!confirm('Cancel this booking?')) return;
  await updateBookingStatus(bookingId, 'Cancelled', closeAfter);
}

async function restoreBooking(bookingId, closeAfter = false) {
  const booking = getBookingById(bookingId);
  if (!booking) return;
  await updateBookingStatus(bookingId, 'Confirmed', closeAfter);
}

async function deleteBooking(bookingId, closeAfter = false) {
  const booking = getBookingById(bookingId);
  if (!booking) return;
  const linkedJob = getJobByBookingId(bookingId);
  const linkedJobCopy = linkedJob ? ' The linked job card will stay, but it will no longer be connected to this booking.' : '';
  if (!confirm(`Delete this booking from history?${linkedJobCopy}`)) return;
  await invoke('delete_booking', { bookingId });
  await syncAfterCloudMutation();
  if (closeAfter) closeModal();
  toast('Booking deleted');
  await render();
}

// ── ACTIONS ───────────────────────────────────────────────────────────────
function setSettingsCategory(category) {
  state.settingsCategory = normalizeSettingsCategory(category);
  void renderInPlace();
}

async function persistSettings({ showToast = true, rerender = true } = {}) {
  if (!isCloudSignedIn()) {
    setSignedOutWorkspaceNotice();
    if (rerender) await render();
    return state.settings;
  }
  const garageNameInput = document.getElementById('settings-garage-name');
  const garageAddressInput = document.getElementById('settings-garage-address');
  const garagePhoneInput = document.getElementById('settings-garage-phone');
  const garageEmailInput = document.getElementById('settings-garage-email');
  const garageWebsiteInput = document.getElementById('settings-garage-website');
  const vatNumberInput = document.getElementById('settings-vat-number');
  const companyNumberInput = document.getElementById('settings-company-number');
  const paymentTermsInput = document.getElementById('settings-payment-terms');
  const bankDetailsInput = document.getElementById('settings-bank-details');
  const distanceUnitInput = document.getElementById('settings-distance-unit');
  const languageInput = document.getElementById('settings-language');
  const currencyInput = document.getElementById('settings-currency');
  const vatEnabledInput = document.getElementById('settings-vat-enabled');
  const defaultVatRateInput = document.getElementById('settings-default-vat-rate');
  if (!garageNameInput || !distanceUnitInput || !currencyInput || !vatEnabledInput) return;

  state.settings = await invoke('save_app_settings', {
    settings: buildAppSettingsPayload({
      garage_name: garageNameInput.value.trim(),
      garage_address: garageAddressInput?.value || '',
      garage_phone: garagePhoneInput?.value || '',
      garage_email: garageEmailInput?.value || '',
      garage_website: garageWebsiteInput?.value || '',
      vat_number: vatNumberInput?.value || '',
      company_number: companyNumberInput?.value || '',
      payment_terms: paymentTermsInput?.value || '',
      bank_details: bankDetailsInput?.value || '',
      language: languageInput?.value || getAppLanguage(),
      distance_unit: distanceUnitInput.value,
      currency: currencyInput.value.trim().toUpperCase(),
      vat_enabled: vatEnabledInput.value === 'true',
      default_vat_rate: defaultVatRateInput?.value ?? getDefaultVatRate(),
    })
  });

  await syncAfterCloudMutation();
  applyAppSettingsToChrome();
  const wasSetupMode = Boolean(state.garageSetupMode);
  if (wasSetupMode) {
    resetToDashboardAfterLogin();
  }
  if (showToast) toast(wasSetupMode ? 'Garage profile saved' : 'Settings saved');
  if (rerender) await render();
  return state.settings;
}

async function saveSettings() {
  await persistSettings();
}

async function saveBookingSettings() {
  if (!isCloudSignedIn()) {
    setSignedOutWorkspaceNotice();
    await render();
    return state.settings;
  }
  const intervalInput = document.getElementById('settings-booking-slot-interval');
  const allowPastInput = document.getElementById('settings-allow-past-booking-times');
  if (!intervalInput || !allowPastInput) return state.settings;

  state.settings = await invoke('save_app_settings', {
    settings: buildAppSettingsPayload({
      booking_slot_interval: intervalInput.value,
      allow_past_booking_times: allowPastInput.checked,
    })
  });

  await syncAfterCloudMutation();
  toast('Booking settings saved');
  await render();
  return state.settings;
}

async function saveInventorySettings() {
  if (!isCloudSignedIn()) {
    setSignedOutWorkspaceNotice();
    await render();
    return state.settings;
  }
  const enabledInput = document.getElementById('settings-inventory-enabled');
  if (!enabledInput) return state.settings;

  state.settings = await invoke('save_app_settings', {
    settings: buildAppSettingsPayload({
      inventory_enabled: enabledInput.checked,
    })
  });

  await syncAfterCloudMutation();
  toast('Inventory settings saved');
  await render();
  return state.settings;
}

async function updateJobStatus(jobId, status) {
  const job = state.jobs.find(j => j.id === jobId);
  if (!job) return;
  let shouldContinue = false;
  try {
    shouldContinue = await confirmPendingLinesBeforeStatusChange(jobId, status);
  } catch (error) {
    alert(String(error));
    await renderInPlace();
    return;
  }
  if (!shouldContinue) {
    await renderInPlace();
    return;
  }
  const updatedJob = normalizeJobMileageForSave({ ...job, id: jobId, status, date_opened: job.date_opened || '' });
  await invoke('save_job_card', { job: updatedJob });
  mergeLocalJob(jobId, updatedJob);
  mergeLocalMileageForJob(updatedJob, updatedJob.mileage_in);
  await syncAfterCloudMutation();
  if (state.screen === 'jobs' && state.selectedJob === jobId && status === 'Completed' && normalizeJobStatusFilter(state.jobStatusFilter) === 'active') {
    state.selectedJob = null;
  }
  toast(`Status → ${status}`); render();
}

async function markJobReadyAndSendSms(jobId) {
  const job = state.jobs.find(j => j.id === jobId);
  if (!job) return;
  let shouldContinue = false;
  try {
    shouldContinue = await confirmPendingLinesBeforeStatusChange(jobId, 'Ready');
  } catch (error) {
    alert(String(error));
    await renderInPlace();
    return;
  }
  if (!shouldContinue) {
    await renderInPlace();
    return;
  }
  const updatedJob = normalizeJobMileageForSave({ ...job, id: jobId, status: 'Ready', date_opened: job.date_opened || '' });
  await invoke('save_job_card', { job: updatedJob });
  mergeLocalJob(jobId, updatedJob);
  mergeLocalMileageForJob(updatedJob, updatedJob.mileage_in);
  await syncAfterCloudMutation();
  await sendAutomaticJobReadySms(updatedJob, { requireAutoEnabled: false });
  toast('Status → Ready');
  await render();
}

async function saveJobField(jobId, field, value) {
  const job = state.jobs.find(j => j.id === jobId);
  if (!job) return;
  const updated = normalizeJobMileageForSave({ ...job, [field]: value, id: jobId, date_opened: job.date_opened || '' });
  await invoke('save_job_card', { job: updated });
  mergeLocalJob(jobId, updated);
  mergeLocalMileageForJob(updated, updated.mileage_in);
  await syncAfterCloudMutation();
}

async function saveJobFieldNum(jobId, field, value) {
  await saveJobField(jobId, field, parseDistanceInput(value));
}

function getNewLineFocusId(lineId) {
  return isInventoryEnabled() ? `job-line-${lineId}-inventory_item_id` : `job-line-${lineId}-description`;
}

async function addJobLine(jobId) {
  const newLine = { id: null, job_id: jobId, inventory_item_id: null, worker_id: null, line_type: DEFAULT_LINE_TYPE, description: '', qty: 1.0, unit_price: 0.0, line_status: 'confirmed' };
  const lineId = await invoke('save_job_line', { line: newLine });
  state.allJobLines = [...(state.allJobLines || []), { ...newLine, id: lineId }];
  state.selectedJob = jobId;
  state.pendingFocusId = getNewLineFocusId(lineId);
  state.pendingFocusSelectAll = false;
  state.pendingFocusSerial = state.userInteractionSerial;
  await renderInPlace();
  await syncAfterCloudMutation();
}

async function handleJobLineUnitPriceEnter(event, jobId, lineId) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  await updateLineNum(lineId, 'unit_price', event.target.value);
  if (state.invoiceEditorId !== null) {
    await addInvoiceLine(jobId);
    return;
  }
  await addJobLine(jobId);
}

async function updateLine(lineId, field, value) {
  const line = getLineById(lineId);
  if (!line) return;
  const nextValue = field === 'line_status'
    ? normalizeLineStatus(value)
    : (field === 'worker_id' ? normalizeWorkerId(value) : value);
  if (field === 'line_status') {
    if (normalizeLineStatus(line.line_status) === nextValue) return;
  } else if (line[field] === nextValue) {
    return;
  }
  try {
    await invoke('save_job_line', { line: { ...line, id: lineId, [field]: nextValue } });
  } catch (error) {
    alert(String(error));
    await refreshInventoryState();
    await renderInPlace();
    return;
  }
  syncLineState(lineId, { [field]: nextValue });
  if (field === 'qty' || field === 'line_type' || field === 'inventory_item_id' || Number(line.inventory_item_id || 0)) {
    await refreshInventoryState();
  }
  const totalCell = document.getElementById(`job-line-${lineId}-total`);
  const updatedLine = getLineById(lineId);
  if (totalCell && updatedLine) {
    totalCell.textContent = fmt((Number(updatedLine.qty) || 0) * (Number(updatedLine.unit_price) || 0));
  }
  syncLineStatusUi(lineId);
  previewLineTotalsFromInputs();
  const editingInvoiceLine = state.invoiceEditorId !== null && state.invoiceLines.some(item => item.id === lineId);
  if (editingInvoiceLine) {
    syncInvoiceEditorTotalsUi();
    setInvoiceEditorDirty(true);
    return;
  }
  await syncAfterCloudMutation();
}

async function updateLineNum(lineId, field, value) {
  await updateLine(lineId, field, parseFloat(value)||0);
}

async function setLineType(lineId, lineType) {
  const normalizedType = LINE_TYPES.includes(lineType) ? lineType : DEFAULT_LINE_TYPE;
  const line = getLineById(lineId);
  if (!line) return;
  const inventoryFields = getLineInventorySnapshot(null);
  const updatedLine = {
    ...line,
    id: lineId,
    line_type: normalizedType,
    inventory_item_id: isInventoryEnabled() && normalizedType === 'Part' ? line.inventory_item_id : null,
  };
  try {
    await invoke('save_job_line', { line: updatedLine });
  } catch (error) {
    alert(String(error));
    await refreshInventoryState();
    await renderInPlace();
    return;
  }
  syncLineState(lineId, {
    line_type: normalizedType,
    inventory_item_id: updatedLine.inventory_item_id,
    ...(updatedLine.inventory_item_id ? {} : inventoryFields),
  });
  const editingInvoiceLine = state.invoiceEditorId !== null && state.invoiceLines.some(item => item.id === lineId);
  await refreshInventoryState();
  replaceLineEditorRow(lineId);
  previewLineTotalsFromInputs();
  if (editingInvoiceLine) {
    syncInvoiceEditorTotalsUi();
    setInvoiceEditorDirty(true);
    return;
  }
  await syncAfterCloudMutation();
}

async function applyInventoryToLine(lineId, itemId, { focusNext = false } = {}) {
  if (!isInventoryEnabled()) return;
  const line = getLineById(lineId);
  if (!line) return;
  const item = getInventoryItemById(itemId);
  const inventoryFields = getLineInventorySnapshot(item);
  const updatedLine = {
    ...line,
    id: lineId,
    inventory_item_id: item ? Number(item.id) : null,
    ...(item ? {
      line_type: 'Part',
      description: getInventoryPartName(item),
      unit_price: getInventorySellPrice(item),
    } : {}),
  };
  try {
    await invoke('save_job_line', { line: updatedLine });
  } catch (error) {
    alert(String(error));
    await refreshInventoryState();
    await renderInPlace();
    return;
  }
  syncLineState(lineId, {
    inventory_item_id: updatedLine.inventory_item_id,
    ...inventoryFields,
    ...(item ? {
      line_type: updatedLine.line_type,
      description: updatedLine.description,
      unit_price: updatedLine.unit_price,
    } : {}),
  });
  await refreshInventoryState();
  replaceLineEditorRow(lineId, { focusQty: focusNext });
  const editingInvoiceLine = state.invoiceEditorId !== null && state.invoiceLines.some(line => line.id === lineId);
  if (editingInvoiceLine) {
    syncInvoiceEditorTotalsUi();
    setInvoiceEditorDirty(true);
    return;
  }
  await syncAfterCloudMutation();
}

async function deleteLine(lineId) {
  await invoke('delete_job_line', { id: lineId });
  const editingInvoiceLine = state.invoiceEditorId !== null && state.invoiceLines.some(item => item.id === lineId);
  if (editingInvoiceLine) {
    removeLineFromState(lineId);
    syncInvoiceEditorTotalsUi();
    setInvoiceEditorDirty(true);
    await refreshInvoiceEditorModal();
    return;
  }
  await syncAfterCloudMutation();
  await renderInPlace();
}

async function addInvoiceLine(jobId) {
  const newLine = { id: null, job_id: jobId, inventory_item_id: null, worker_id: null, line_type: DEFAULT_LINE_TYPE, description: '', qty: 1.0, unit_price: 0.0, line_status: 'confirmed' };
  const lineId = await invoke('save_job_line', { line: newLine });
  state.invoiceLines = [...state.invoiceLines, { ...newLine, id: lineId }];
  state.allJobLines = [...(state.allJobLines || []), { ...newLine, id: lineId }];
  syncInvoiceEditorTotalsUi();
  setInvoiceEditorDirty(true);
  state.pendingFocusId = getNewLineFocusId(lineId);
  state.pendingFocusSelectAll = false;
  state.pendingFocusSerial = state.userInteractionSerial;
  await refreshInvoiceEditorModal();
}

async function toggleLineStatus(lineId) {
  const line = state.invoiceLines.find(item => item.id === lineId) || state.jobLines.find(item => item.id === lineId);
  if (!line) return;
  const nextStatus = isLinePending(line) ? 'confirmed' : 'pending';
  await updateLine(lineId, 'line_status', nextStatus);
}

function buildInvoicePayload(invoiceId, overrides = {}) {
  const inv = getInvoiceById(invoiceId);
  if (!inv) return null;
  const status = normalizeInvoiceStatusValue(overrides.status ?? inv.status ?? 'Unpaid');
  return {
    id: invoiceId,
    job_id: inv.job_id,
    invoice_number: String(overrides.invoice_number ?? inv.invoice_number ?? '').trim(),
    date_issued: String(overrides.date_issued ?? inv.date_issued ?? ''),
    due_date: String(overrides.due_date ?? inv.due_date ?? ''),
    status,
    payment_method: String(overrides.payment_method ?? inv.payment_method ?? ''),
    paid_amount: normalizeInvoicePaidAmount(overrides.paid_amount ?? inv.paid_amount ?? 0),
    paid_at: String(overrides.paid_at ?? inv.paid_at ?? ''),
    notes: String(overrides.notes ?? inv.notes ?? ''),
    vat_rate: getAppliedVatRate(),
  };
}

async function saveInvoice(invoiceId, overrides = {}, { rerender = true, syncCloud = true } = {}) {
  const invoice = buildInvoicePayload(invoiceId, overrides);
  if (!invoice) return null;
  await invoke('save_invoice', { invoice });
  const currentInvoice = getInvoiceById(invoiceId);
  if (currentInvoice) {
    Object.assign(currentInvoice, invoice);
  }
  if (state.invoiceEditorId === invoiceId) {
    syncInvoiceEditorTotalsUi(invoiceId);
  }
  if (syncCloud) {
    await syncAfterCloudMutation();
  }
  if (rerender) {
    await refreshInvoicesState();
    if (state.screen === 'invoices') await renderInPlace();
    await refreshInvoiceEditorModal({ reloadLines: true });
  }
  return invoice;
}

async function saveInvoiceField(invoiceId, field, value) {
  const inv = getInvoiceById(invoiceId);
  if (!inv) return;
  if ((inv[field] ?? '') === value) return;
  const localOnly = state.invoiceEditorId === invoiceId;
  await saveInvoice(invoiceId, { [field]: value }, { rerender: !localOnly, syncCloud: !localOnly });
  if (!localOnly) return;
  setInvoiceEditorDirty(true);
  if (field === 'status') {
    await refreshInvoiceEditorModal();
    return;
  }
  updateInvoiceEditorSaveUi();
}

async function handleInvoiceStatusChange(invoiceId, value) {
  const inv = getInvoiceById(invoiceId);
  if (!inv) return;
  const status = normalizeInvoiceStatusValue(value);
  const invoiceTotal = getInvoiceTotalAmount(inv);
  const paidAmount = status === 'Paid'
    ? invoiceTotal
    : (status === 'Partial' ? normalizeInvoicePaidAmount(inv.paid_amount ?? 0, invoiceTotal) : 0);
  const paidAt = status === 'Paid' ? (inv.paid_at || formatDateInputValue()) : '';
  const localOnly = state.invoiceEditorId === invoiceId;
  await saveInvoice(invoiceId, { status, paid_amount: paidAmount, paid_at: paidAt }, { rerender: !localOnly, syncCloud: !localOnly });
  if (!localOnly) return;
  setInvoiceEditorDirty(true);
  await refreshInvoiceEditorModal();
}

function previewInvoicePaidAmount(invoiceId, value) {
  const inv = getInvoiceById(invoiceId);
  if (!inv) return;
  const totals = calculateInvoiceDraftTotals({ ...inv, status: 'Partial', paid_amount: value }, state.invoiceLines);
  const paidAmount = document.getElementById('invoice-editor-paid-amount');
  const balanceDue = document.getElementById('invoice-editor-balance-due');
  if (paidAmount) paidAmount.textContent = fmt(totals.paidAmount);
  if (balanceDue) balanceDue.textContent = fmt(totals.balanceDue);
}

async function saveInvoicePaidAmount(invoiceId, value) {
  const inv = getInvoiceById(invoiceId);
  if (!inv) return;
  const invoiceTotal = getInvoiceTotalAmount(inv);
  const paidAmount = normalizeInvoicePaidAmount(value, invoiceTotal);
  const localOnly = state.invoiceEditorId === invoiceId;
  await saveInvoice(invoiceId, { status: 'Partial', paid_amount: paidAmount }, { rerender: !localOnly, syncCloud: !localOnly });
  if (!localOnly) return;
  const input = document.getElementById(`invoice-${invoiceId}-paid-amount`);
  if (input) input.value = paidAmount ? paidAmount.toFixed(2) : '';
  syncInvoiceEditorTotalsUi(invoiceId);
  setInvoiceEditorDirty(true);
}

async function saveInvoiceFieldNum(invoiceId, field, value) {
  const numericValue = normalizeVatRate(value);
  const inv = getInvoiceById(invoiceId);
  if (!inv) return;
  if (Number(inv[field] || 0) === numericValue) return;
  const localOnly = state.invoiceEditorId === invoiceId;
  await saveInvoice(invoiceId, { [field]: numericValue }, { rerender: !localOnly, syncCloud: !localOnly });
  if (!localOnly) return;
  syncInvoiceEditorTotalsUi(invoiceId);
  setInvoiceEditorDirty(true);
}

async function createOrOpenInvoiceForJob(jobId, { toastOnExisting = true } = {}) {
  const numericJobId = parseInt(jobId, 10);
  if (!numericJobId) {
    alert('Select a job card');
    return null;
  }
  const existingInvoice = getInvoiceByJobId(numericJobId);
  const invoiceId = await invoke('generate_invoice', { jobId: numericJobId });
  await refreshInvoicesState();
  if (state.screen === 'invoices') {
    await renderInPlace();
  }
  state.invoiceCreateDraft = null;
  state.invoiceEditorDirty = !existingInvoice;
  await showInvoiceEditor(invoiceId);
  if (existingInvoice) {
    if (toastOnExisting) toast(`Opened ${existingInvoice.invoice_number}`);
  } else {
    toast('Invoice created locally');
  }
  return invoiceId;
}

async function createInvoiceFromDraft() {
  const draft = getInvoiceCreateDraft();
  await createOrOpenInvoiceForJob(draft.jobId);
}

async function genInvoice(jobId) {
  await createOrOpenInvoiceForJob(jobId, { toastOnExisting: false });
}

async function saveInvoiceEditorToCloud() {
  if (!state.invoiceEditorDirty) {
    toast('Invoice is already backed up');
    return;
  }
  state.invoiceEditorCloudSaving = true;
  updateInvoiceEditorSaveUi();
  try {
    await syncAfterCloudMutation();
    toast('Invoice backed up');
  } catch (error) {
    console.error('Invoice cloud sync failed', error);
    alert(String(error));
  } finally {
    state.invoiceEditorCloudSaving = false;
    updateInvoiceEditorSaveUi();
  }
}

async function markPaid(invoiceId) {
  const inv = getInvoiceById(invoiceId);
  const method = String(inv?.payment_method || 'Cash');
  await invoke('mark_invoice_paid', { id: invoiceId, method });
  if (inv) {
    inv.status = 'Paid';
    inv.payment_method = method;
    inv.paid_amount = getInvoiceTotalAmount(inv);
    inv.paidAmount = inv.paid_amount;
    inv.balanceDue = 0;
    inv.paid_at = formatDateInputValue();
  }
  if (state.invoiceEditorId === invoiceId) {
    setInvoiceEditorDirty(true);
    toast('Marked as paid locally');
    await refreshInvoiceEditorModal();
    return;
  }
  await syncAfterCloudMutation();
  toast('Marked as paid');
  await refreshInvoicesState();
  if (state.screen === 'invoices') await renderInPlace();
  await refreshInvoiceEditorModal({ reloadLines: true });
}

async function openClient(clientId) {
  state.selectedClient = clientId;
  state.screen = 'clients';
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.screen === 'clients'));
  document.getElementById('topbar-title').textContent = 'Customers';
  setTopbarPrimaryButton({
    label: '+ Add Vehicle',
    onClick: () => showVehicleModal(null, clientId),
  });
  await render();
}

function openJob(jobId) {
  state.selectedJob = jobId;
  state.screen = 'jobs';
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.screen === 'jobs'));
  document.getElementById('topbar-title').textContent = 'Jobs';
  setTopbarPrimaryButton({ hidden: true });
  render();
}

async function backToJobs() {
  state.selectedJob = null;
  state.screen = 'jobs';
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.screen === 'jobs'));
  document.getElementById('topbar-title').textContent = 'Jobs';
  setTopbarPrimaryButton({ hidden: true });
  await render();
}

async function selectInvoice(invoiceId) {
  await showInvoiceEditor(invoiceId);
}

function clearPrintMode() {
  leavePrintMode();
}

async function printInvoice(invoiceId = state.selectedInvoice) {
  if (!invoiceId) {
    alert('Select an invoice to print');
    return;
  }
  if (state.screen !== 'invoices' || state.selectedInvoice !== invoiceId) {
    state.screen = 'invoices';
    state.selectedInvoice = invoiceId;
    document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.screen === 'invoices'));
    document.getElementById('topbar-title').textContent = 'Invoices';
    setTopbarPrimaryButton({
      label: '+ New Invoice',
      onClick: () => primaryAction('invoices'),
    });
    await render();
  }
  const inv = getInvoiceById(invoiceId);
  if (!inv) {
    alert('Invoice not found');
    return;
  }
  state.invoiceLines = await invoke('get_job_lines', { jobId: inv.job_id });
  enterPrintMode(inv);
  try {
    await new Promise(resolve => setTimeout(resolve, 180));
    await Promise.resolve(window.print());
  } catch (error) {
    clearPrintMode();
    console.error('Print failed', error);
    alert('Unable to open the print dialog. Restart the app and try again.');
    return;
  }
  const cleanup = () => {
    window.removeEventListener('focus', cleanup);
    setTimeout(clearPrintMode, 120);
  };
  window.addEventListener('focus', cleanup, { once: true });
  setTimeout(clearPrintMode, 10000);
}

async function renderInPlace() {
  try {
    const authGate = document.getElementById('auth-gate');
    const c = document.getElementById('content');
    if (!isCloudSignedIn()) {
      resetAdminAccess();
      if (isAdminRoutePath()) setRouteForScreen('dashboard', { replace: true });
      state.screen = 'settings';
      setMobileNavOpen(false);
      document.getElementById('app').classList.add('auth-only');
      authGate.innerHTML = renderAuthGate();
      applyLanguageToDom(authGate);
      bindEvents();
      return;
    }
    await ensureAdminAccess();
    if (state.screen === 'admin' && !isCurrentUserAdmin()) {
      resetAdminStats();
      state.screen = 'dashboard';
      setRouteForScreen('dashboard', { replace: true });
    }
    document.getElementById('app').classList.remove('auth-only');
    authGate.innerHTML = '';
    renderSidebarNav();
    setMobileNavOpen(state.mobileNavOpen);
    updateTopbarForScreen(state.screen);
    const activeSnapshot = snapshotActiveField(c);
    if (state.screen === 'dashboard') c.innerHTML = renderDashboard();
    else if (state.screen === 'admin') c.innerHTML = renderAdminScreenContent();
    else if (state.screen === 'clients' && !state.selectedClient) c.innerHTML = renderClients();
    else if (state.screen === 'vehicles') c.innerHTML = renderVehicles();
    else if (state.screen === 'jobs') { if (state.selectedJob !== null) c.innerHTML = await renderJobCard(); else c.innerHTML = renderJobs(); }
    else if (state.screen === 'invoices') c.innerHTML = await renderInvoices();
    else if (state.screen === 'reports') c.innerHTML = renderReports();
    else if (state.screen === 'inventory') c.innerHTML = renderInventory();
    else if (state.screen === 'calendar') c.innerHTML = renderCalendarView();
    else if (state.screen === 'messages') c.innerHTML = renderMessages();
    else if (state.screen === 'billing') c.innerHTML = await renderBilling();
    else if (state.screen === 'settings') c.innerHTML = await renderSettings();
    restoreActiveField(activeSnapshot);
    restorePersistentModal();
    applyLanguageToDom(document);
    bindEvents();
    applyPendingFocus();
  } catch (error) {
    renderAppRecovery(error);
  }
}

function bindEvents() {
  // expose globals for inline handlers
}

// ── INIT ──────────────────────────────────────────────────────────────────
document.getElementById('app').innerHTML = `
  <div id="auth-gate" class="auth-gate"></div>
  <div class="sidebar">
    <div class="logo">
      <img class="logo-wordmark" src="${BRAND_LOGO_SRC}" alt="Garage CRM" />
    </div>
    <nav id="sidebar-nav"></nav>
  </div>
  <div id="mobile-nav-backdrop" class="mobile-nav-backdrop" onclick="closeMobileNav()"></div>
  <div class="main">
    <div class="topbar">
      <div class="topbar-main">
        <button id="mobile-menu-toggle" class="mobile-menu-toggle" type="button" onclick="toggleMobileNav()" aria-label="Toggle menu" aria-expanded="false">
          <span></span>
          <span></span>
          <span></span>
        </button>
        <div id="topbar-title" class="topbar-title">Dashboard</div>
      </div>
    </div>
    <div id="content" class="content"></div>
  </div>
  <div id="toast" class="toast"></div>
`;

ensurePrintRoot();
document.addEventListener('input', () => { state.userInteractionSerial += 1; }, true);
document.addEventListener('keydown', event => {
  const key = typeof event.key === 'string' ? event.key : '';
  if (key.length === 1 || key === 'Backspace' || key === 'Delete' || key === 'Enter') {
    state.userInteractionSerial += 1;
  }
}, true);
document.addEventListener('pointerdown', () => { state.userInteractionSerial += 1; }, true);
document.addEventListener('pointerdown', handleClickablePointerDown, true);
document.addEventListener('click', guardClickableRowClick, true);
window.addEventListener('pointermove', handleNavPointerMove);
window.addEventListener('pointerup', handleNavPointerUp);
window.addEventListener('pointercancel', handleNavPointerUp);
window.addEventListener('focus', refreshBillingAfterExternalReturn);
window.addEventListener('focus', () => {
  void refreshCloudWorkspaceAndRender({ silent: false });
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    void refreshCloudWorkspaceAndRender({ silent: true });
  }
});
setInterval(() => {
  void refreshCloudWorkspaceAndRender({ silent: true });
}, CLOUD_REMOTE_REFRESH_INTERVAL_MS);
window.addEventListener('error', event => {
  renderAppRecovery(event.error || event.message);
});
window.addEventListener('unhandledrejection', event => {
  renderAppRecovery(event.reason || 'Unexpected startup error');
});

// expose functions globally for inline handlers
  Object.assign(window, { nav, toggleMobileNav, closeMobileNav, handleNavClick, handleNavPointerDown, setTableSort, openInventory, setInventoryFilter, showInventoryItemModal, refreshInventoryItemPricing, refreshInventoryItemValuePreview, saveInventoryItem, showInventoryMovementModal, saveInventoryMovement, deleteInventoryItem, setMessageFilter, setMessageQuickFilter, sendMessageAction, showSmsComposeModal, sendSmsFromCompose, saveMessageSettings, showTestSmsModal, prefillSmsRecipient, updateSmsComposeTemplate, showCustomerSmsModal, showVehicleSmsModal, showBookingSmsModal, showJobCompletedSmsModal, setJobStatusFilter, setReportsDateFilter, setReportsSection, updateReportsCustomDate, saveWorkerFromReport, editWorker, cancelWorkerEdit, toggleWorkerActive, exportReportCsv, exportReportPdf, printReport, clearReportPrintMode, openClient, openJob, backToJobs, showInvoiceEditor, showInvoiceCreateModal, setInvoiceCreateClient, setInvoiceCreateVehicle, setInvoiceCreateJob, createInvoiceFromDraft, showClientModal, saveClient, deleteClient, syncCloudField, setCloudAuthMode, signUpCloudAccount, verifyCloudEmailCode, resendCloudVerificationCode, signInCloudAccount, sendCloudPasswordReset, completeCloudPasswordReset, signOutCloudAccount, syncAccountToCloud, restoreAccountFromCloud, checkForAppUpdate, installAppUpdate, startBillingCheckout, openBillingPortal, refreshBillingStatus, copyCheckoutLink, copyVehicleVin, lookupDvlaVehicle, showVehicleModal, saveVehicle, deleteVehicle, showJobModal, saveJob, applyBookingToJobModal, refreshJobBookingPicker, updateJobBookingPickerFilter, selectJobSourceBooking, setJobClientSelection, setJobVehicleSelection, updateJobClientSearch, updateJobVehicleSearch, refreshJobDirectPicker, refreshJobClientTypeahead, refreshJobVehicleTypeahead, filterVehiclesForClient, showBookingFlow, updateBookingSearch, setBookingClientMode, selectBookingClient, clearBookingClientSelection, selectBookingVehicle, setBookingVehicleMode, updateBookingDate, chooseBookingTime, saveBookingFlow, setCalendarViewMode, setCalendarSlotInterval, setPastBookingTimesMode, goCalendarToday, togglePastBookingTimes, changeCalendarWeek, handleBookingModalClientChange, handleBookingModalVehicleChange, handleBookingModalDateChange, showBookingModal, saveBooking, cancelBooking, restoreBooking, deleteBooking, setSettingsCategory, saveSettings, saveBookingSettings, setDashboardDateFilter, setClientStatusFilter, setClientVehicleFilter, setClientLastVisitFilter, toggleJobLineSort: toggleJobLineSort, updateJobStatus, markJobReadyAndSendSms, saveJobField, saveJobFieldNum, addJobLine, addInvoiceLine, saveInvoice, saveInvoiceField, saveInvoiceFieldNum, handleInvoiceStatusChange, previewInvoicePaidAmount, saveInvoicePaidAmount, saveInvoiceEditorToCloud, handleJobLineUnitPriceEnter, clearZeroNumberInput, previewLineNumberInput, updateLine, updateLineNum, setLineType, updateInventoryLineSearch, closeInventoryLineSearch, handleInventoryLineSearchKey, applyInventoryToLine, toggleLineStatus, deleteLine, genInvoice, markPaid, printInvoice, clearPrintMode, selectInvoice, setAdminSection, refreshAdminDashboard, saveAdminReferralCode, editAdminReferralCode, cancelAdminReferralEdit, markAdminReferralCommissionPaid, setBillingReferralCode, render, renderInPlace, retryAppRender, closeModal, state });
window.saveInventorySettings = saveInventorySettings;

applyRouteFromLocation();
window.addEventListener('popstate', () => {
  applyRouteFromLocation();
  void render();
});

initializeSupabaseAuth().finally(() => {
  render();
});
