// 🔑 IDs của các Google Sheet
const KEY_ACCOUNT_SHEET_ID = "1nfeh_cnEOn9UKz2pYucINirHmpVD1Yx9MX_KUTlwywk";
const DSTC_SHEET_ID = "1E7YY6EwWpcECmVQmviSU7tXejjt1CyD5jkoKvMo5t3Y";

// ⏱️ Thời gian sống & Rate Limit
const OTP_TTL = 120; // 2 phút
const SESSION_TTL = 21600; // 6 giờ (Thời gian phiên làm việc tối đa của CacheService)
const PERSISTENT_SESSION_TTL = 30 * 24 * 3600; // 30 ngày (giây) cho Persistent Session
const SHORT_SESSION_TTL = 6 * 3600; // 6 giờ (giây) cho phiên không ghi nhớ
const ROLLING_WINDOW_MS = 24 * 3600 * 1000; // 24 giờ để throttle rolling extension
const OTP_COOLDOWN_TTL = 60; // 60 giây giữa 2 lần gửi cho cùng 1 email
const GLOBAL_OTP_WINDOW_TTL = 600; // 10 phút cửa sổ rate limit toàn cục
const GLOBAL_OTP_LIMIT = 30; // Tối đa 30 OTP / 10 phút trên toàn hệ thống


// 🌐 Entry point cho Web App (phục vụ fallback giao diện nội bộ)
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle("Tra cứu DSTC - Admicro")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

// 🌐 Entry point REST API (tiếp nhận POST request từ Frontend Vercel)
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: "Dữ liệu yêu cầu không hợp lệ."
      })).setMimeType(ContentService.MimeType.JSON);
    }

    let data;
    try {
      data = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: "Dữ liệu JSON không đúng định dạng."
      })).setMimeType(ContentService.MimeType.JSON);
    }

    const action = data.action;
    let result;

    switch (action) {
      case 'sendOtp':
        result = sendOtp(data.email);
        break;
      case 'verifyOtp':
        result = verifyOtp(data.email, data.otp, data.rememberMe);
        break;
      case 'verifyGoogleToken':
        result = verifyGoogleToken(data.credential, data.rememberMe);
        break;
      case 'verifySession':
        result = verifySession(data.token);
        break;
      case 'logout':
        result = revokeSession(data.token);
        break;
      case 'getFilteredData':
        result = getFilteredData(data);
        break;
      case 'getAllPossibleTeams':
        result = getAllPossibleTeams(data.token);
        break;
      case 'getPermissionsList':
        result = getPermissionsList(data.token);
        break;
      case 'savePermission':
        result = savePermission(data.token, data.pData);
        break;
      case 'deletePermission':
        result = deletePermission(data.token, data.email);
        break;
      default:
        result = { success: false, error: "Action không hợp lệ: " + action };
        break;
    }

    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    console.error("Lỗi trong doPost:", err);
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: "Lỗi hệ thống: " + (err.message || err.toString())
    })).setMimeType(ContentService.MimeType.JSON);
  }
}


// 📤 Gửi OTP đến email — trả về { success: true } nếu gửi được (không tiết lộ email có tồn tại hay không)
function sendOtp(email) {
  try {
    email = (email || '').toString().trim().toLowerCase();
    if (!email || !/\S+@\S+\.\S+/.test(email)) {
      return { success: false, error: "Email không hợp lệ" };
    }

    const emailHash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, email).map(b => (b + 256) % 256).join('');
    const cache = CacheService.getScriptCache();
    const cooldownKey = "CD_" + emailHash;
    const globalCountKey = "GLOBAL_OTP_COUNT";

    // 1. Chỉ email đã được cấp quyền mới được dùng quota gửi mail.
    // Vẫn trả generic success cho email ngoài hệ thống để tránh account enumeration.
    const { teams, role } = getTeamsForEmail(email);
    if (teams.length === 0 && role !== 'Admin') {
      console.info("Email không có quyền trong hệ thống, bỏ qua gửi mail:", email);
      return { success: true };
    }

    // 2. Kiểm tra nhanh cooldown trước khi chờ lock.
    if (cache.get(cooldownKey)) {
      return {
        success: false,
        error: "Mã OTP vừa được gửi. Vui lòng chờ 60 giây trước khi yêu cầu mã mới."
      };
    }

    // 3. Atomic reservation cho cooldown và global budget.
    const lock = LockService.getScriptLock();
    let lockAcquired = false;
    try {
      lockAcquired = lock.tryLock(3000);
    } catch (e) {
      console.warn("Lock acquire error:", e);
    }

    if (!lockAcquired) {
      console.warn("sendOtp: Không lấy được script lock, fail-closed an toàn.");
      return { success: false, error: "Hệ thống đang bận. Vui lòng thử lại sau vài giây." };
    }

    try {
      // Re-check dưới lock để chặn hai request đồng thời cho cùng email.
      if (cache.get(cooldownKey)) {
        return {
          success: false,
          error: "Mã OTP vừa được gửi. Vui lòng chờ 60 giây trước khi yêu cầu mã mới."
        };
      }

      // Kiểm tra global budget trong 10 phút
      let currentGlobalCount = parseInt(cache.get(globalCountKey) || '0', 10);
      if (currentGlobalCount >= GLOBAL_OTP_LIMIT) {
        console.warn("sendOtp: Vượt quá Global Rate Limit (" + GLOBAL_OTP_LIMIT + " OTP/10p).");
        return { success: false, error: "Hệ thống đã đạt giới hạn gửi OTP. Vui lòng thử lại sau 10 phút." };
      }

      // Kiểm tra MailApp remaining quota
      let remainingQuota = 100;
      try {
        remainingQuota = MailApp.getRemainingDailyQuota();
      } catch (quotaErr) {
        console.warn("Không lấy được quota:", quotaErr);
      }
      if (remainingQuota <= 5) {
        console.warn("sendOtp: MailApp daily quota sắp cạn (còn " + remainingQuota + ").");
        return { success: false, error: "Hệ thống tạm hết hạn mức gửi email trong ngày. Vui lòng liên hệ quản trị viên." };
      }

      // Reserve budget và cooldown trước khi thả lock để chặn request song song.
      cache.put(globalCountKey, (currentGlobalCount + 1).toString(), GLOBAL_OTP_WINDOW_TTL);
      cache.put(cooldownKey, "1", OTP_COOLDOWN_TTL);

    } finally {
      lock.releaseLock();
    }

    // 4. Sinh OTP 6 chữ số
    const otp = Math.floor(100000 + Math.random() * 900000).toString(); // 100000 → 999999
    const key = "OTP_" + emailHash;
    const expireTime = Date.now() + (OTP_TTL * 1000);
    const props = PropertiesService.getScriptProperties();

    // 5. Gửi email
    try {
      MailApp.sendEmail({
        to: email,
        subject: "[Admicro DSTC] Mã OTP xác thực tra cứu",
        htmlBody: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 20px auto; padding: 20px; border: 1px solid #eee; border-radius: 8px; background: #f9fafb;">
            <h2 style="color: #1e40af;">Mã OTP xác thực</h2>
            <p>Xin chào,</p>
            <p>Mã OTP của bạn để tra cứu DSTC là:</p>
            <div style="text-align: center; margin: 20px 0; font-size: 24px; font-weight: bold; color: #1e40af; background: white; padding: 12px; border-radius: 6px; letter-spacing: 4px;">
              ${otp}
            </div>
            <p>Mã này có hiệu lực trong <strong>2 phút</strong>.</p>
            <p>Nếu bạn không yêu cầu mã này, vui lòng bỏ qua email.</p>
            <hr style="margin: 20px 0;" />
            <p><small>Đây là email tự động từ hệ thống Tra cứu DSTC — Account Admicro.</small></p>
          </div>
        `
      });
      // Chỉ tạo OTP hợp lệ sau khi MailApp xác nhận gửi thành công.
      props.setProperty(key, JSON.stringify({ otp: otp, expire: expireTime, attempts: 0 }));
      console.log("Đã gửi OTP thành công tới:", email);
      logAction(email, "SEND_OTP", "Gửi mã OTP thành công");
    } catch (mailErr) {
      console.error("Lỗi MailApp.sendEmail:", mailErr);
      logAction(email, "SEND_OTP_ERROR", "Lỗi gửi mail: " + (mailErr.message || mailErr.toString()));
      // Hủy cooldown để user có thể thử lại. Global counter vẫn giữ như số lần gọi MailApp
      // nhằm bảo vệ quota trong trường hợp Google đã nhận request nhưng client nhận exception.
      cache.remove(cooldownKey);
      return {
        success: false,
        error: "Không gửi được email OTP: " + (mailErr.message || mailErr.toString())
      };
    }

    return { success: true };

  } catch (e) {
    console.error("Lỗi trong sendOtp:", e);
    return { success: false, error: "Lỗi hệ thống khi gửi OTP" };
  }
}


// ✅ Xác minh OTP — nếu đúng, trả về danh sách team được phép
function verifyOtp(email, otp, rememberMe) {
  try {
    email = (email || '').toString().trim().toLowerCase();
    otp = (otp || '').toString().trim();

    if (!email || !otp) {
      return { valid: false, error: "Vui lòng nhập email và OTP" };
    }

    // Lấy key hash
    const key = "OTP_" + Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, email).map(b => (b + 256) % 256).join('');
    const props = PropertiesService.getScriptProperties();
    const lock = LockService.getScriptLock();

    let lockAcquired = false;
    try {
      lockAcquired = lock.tryLock(3000);
    } catch (e) {
      console.warn("verifyOtp lock error:", e);
    }

    if (!lockAcquired) {
      return { valid: false, error: "Hệ thống đang bận, vui lòng thử lại sau giây lát." };
    }

    let isValid = false;
    let authError = "";

    try {
      const stored = props.getProperty(key);
      if (!stored) {
        isValid = false;
        authError = "OTP không hợp lệ hoặc đã hết hạn";
      } else {
        const parsed = JSON.parse(stored);
        const savedOtp = parsed.otp;
        const expire = parsed.expire;
        let attempts = parsed.attempts || 0;
        const now = Date.now();

        if (now > expire) {
          props.deleteProperty(key);
          isValid = false;
          authError = "OTP đã hết hạn (2 phút)";
        } else if (attempts >= 5) {
          props.deleteProperty(key);
          isValid = false;
          authError = "Bạn đã nhập sai OTP quá 5 lần. Vui lòng yêu cầu mã mới.";
        } else if (savedOtp === otp) {
          // OTP chính xác -> Xóa luôn sau khi dùng 1 lần
          props.deleteProperty(key);
          isValid = true;
        } else {
          // OTP sai -> tăng attempt counter
          attempts += 1;
          if (attempts >= 5) {
            props.deleteProperty(key);
            authError = "Bạn đã nhập sai OTP quá 5 lần. Vui lòng yêu cầu mã mới.";
          } else {
            props.setProperty(key, JSON.stringify({ otp: savedOtp, expire: expire, attempts: attempts }));
            authError = "OTP không chính xác (còn " + (5 - attempts) + " lần thử).";
          }
          isValid = false;
        }
      }
    } finally {
      lock.releaseLock();
    }

    if (!isValid) {
      return { valid: false, error: authError || "OTP không hợp lệ hoặc đã hết hạn" };
    }

    // ✅ OTP đúng → Tạo Session Token bảo mật (thực hiện sau khi đã release lock)
    const { teams, role } = getTeamsForEmail(email);
    if (teams.length === 0 && role !== 'Admin') {
      return { valid: false, error: "Email này không được cấp quyền xem bất kỳ team nào." };
    }

    // Tạo token ngẫu nhiên & lưu vào Cache / Persistent Session
    const token = Utilities.getUuid();
    const isRemember = rememberMe !== false && rememberMe !== 'false';
    savePersistentSession(token, email, role, isRemember);

    // GHI LOG ĐĂNG NHẬP
    logAction(email, 'LOGIN_OTP', 'Đăng nhập OTP thành công (Ghi nhớ: ' + isRemember + ')');

    return { valid: true, token, email, teams, role };

  } catch (e) {
    console.error("Lỗi trong verifyOtp:", e);
    return { valid: false, error: "Lỗi hệ thống khi xác minh OTP" };
  }
}

// ==========================================
// 🛡️ QUẢN LÝ PHIÊN LÀM VIỆC & GOOGLE AUTH (SSO)
// ==========================================

// 📂 Mở hoặc khởi tạo bảng _Sessions lưu trữ phiên bền vững
function getOrCreateSessionsSheet() {
  const ss = SpreadsheetApp.openById(KEY_ACCOUNT_SHEET_ID);
  let sheet = ss.getSheetByName("_Sessions");
  if (!sheet) {
    sheet = ss.insertSheet("_Sessions");
    sheet.appendRow(["Token", "Email", "Role", "CreatedAt", "ExpireAt", "LastActive", "Status"]);
    sheet.setFrozenRows(1);
    sheet.getRange("A1:G1").setFontWeight("bold");
    console.log("Đã tự động khởi tạo bảng _Sessions");
  }
  return sheet;
}

// 💾 Lưu phiên làm việc mới (hỗ trợ phân nhánh Remember Me)
function savePersistentSession(token, email, role, isRememberMe) {
  const now = Date.now();
  const cache = CacheService.getScriptCache();

  if (isRememberMe) {
    // 1. Phiên dài hạn 30 ngày -> Lưu vào Sheet _Sessions (L2) & Cache L1
    const expireAt = now + (PERSISTENT_SESSION_TTL * 1000);
    const lock = LockService.getScriptLock();
    let lockAcquired = false;
    try {
      lockAcquired = lock.tryLock(3000);
    } catch (e) {
      console.warn("savePersistentSession lock error:", e);
    }

    try {
      const sheet = getOrCreateSessionsSheet();
      sheet.appendRow([token, email, role, new Date(now).toISOString(), expireAt, now, "ACTIVE"]);
    } catch (sheetErr) {
      console.error("Lỗi ghi bảng _Sessions:", sheetErr);
    } finally {
      if (lockAcquired) {
        try { lock.releaseLock(); } catch (e) {}
      }
    }

    // Nạp vào Cache L1 với định dạng chuẩn JSON {email, expireAt}
    const ttlL1 = Math.min(SESSION_TTL, PERSISTENT_SESSION_TTL);
    cache.put(token, JSON.stringify({ email: email, expireAt: expireAt }), ttlL1);

  } else {
    // 2. Phiên ngắn hạn 6 giờ (Không ghi nhớ) -> Chỉ lưu trong Cache L1
    const expireAt = now + (SHORT_SESSION_TTL * 1000);
    cache.put(token, JSON.stringify({ email: email, expireAt: expireAt }), SHORT_SESSION_TTL);
  }
}

// 🔍 Giải mã token tập trung áp dụng Hierarchical Cache (L1 CacheRAM + L2 Sheet Store)
function getEmailFromToken(token) {
  if (!token) return null;
  const cache = CacheService.getScriptCache();
  const cachedRaw = cache.get(token);
  const now = Date.now();

  // 1. Kiểm tra L1 Cache (nhanh < 5ms)
  if (cachedRaw) {
    try {
      const parsed = JSON.parse(cachedRaw);
      if (parsed && parsed.email) {
        if (parsed.expireAt && now > parsed.expireAt) {
          cache.remove(token);
          return null; // Đã quá hạn ExpireAt
        }
        return parsed.email;
      }
    } catch (parseErr) {
      // Fallback nếu cache cũ chỉ lưu chuỗi email thô
      return cachedRaw;
    }
  }

  // 2. Cache miss -> Kiểm tra Sheet _Sessions (L2)
  const lock = LockService.getScriptLock();
  let lockAcquired = false;
  try {
    lockAcquired = lock.tryLock(2000);
  } catch (e) {}

  try {
    const ss = SpreadsheetApp.openById(KEY_ACCOUNT_SHEET_ID);
    const sheet = ss.getSheetByName("_Sessions");
    if (!sheet) return null;

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return null;

    const data = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
    for (let i = 0; i < data.length; i++) {
      const [sToken, sEmail, sRole, sCreatedAt, sExpireAt, sLastActive, sStatus] = data[i];
      if (sToken === token && sStatus === "ACTIVE") {
        const expireAt = Number(sExpireAt);
        if (now > expireAt) {
          // Hết hạn phiên -> Đánh dấu EXPIRED trong Sheet
          sheet.getRange(i + 2, 7).setValue("EXPIRED");
          return null;
        }

        // Rolling Expiration: Nếu hoạt động sau hơn 24 giờ kể từ LastActive
        const lastActive = Number(sLastActive) || 0;
        let currentExpireAt = expireAt;
        if (now - lastActive > ROLLING_WINDOW_MS) {
          currentExpireAt = now + (PERSISTENT_SESSION_TTL * 1000);
          sheet.getRange(i + 2, 5, 1, 2).setValues([[currentExpireAt, now]]);
        }

        // Nạp ngược lại vào Cache L1 (Cache-Aside)
        const remainingSeconds = Math.max(1, Math.floor((currentExpireAt - now) / 1000));
        const ttlL1 = Math.min(SESSION_TTL, remainingSeconds);
        cache.put(token, JSON.stringify({ email: sEmail, expireAt: currentExpireAt }), ttlL1);

        return sEmail;
      }
    }
  } catch (err) {
    console.error("Lỗi getEmailFromToken từ L2:", err);
  } finally {
    if (lockAcquired) {
      try { lock.releaseLock(); } catch (e) {}
    }
  }

  return null;
}

// 🚪 Thu hồi phiên làm việc (Đăng xuất)
function revokeSession(token) {
  if (!token) return { success: true };
  try {
    // Xóa Cache L1
    CacheService.getScriptCache().remove(token);

    // Đánh dấu REVOKED trong Sheet L2
    const ss = SpreadsheetApp.openById(KEY_ACCOUNT_SHEET_ID);
    const sheet = ss.getSheetByName("_Sessions");
    if (sheet) {
      const lastRow = sheet.getLastRow();
      if (lastRow >= 2) {
        const tokens = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
        for (let i = 0; i < tokens.length; i++) {
          if (tokens[i][0] === token) {
            sheet.getRange(i + 2, 7).setValue("REVOKED");
            break;
          }
        }
      }
    }
    console.log("Đã thu hồi token phiên:", token);
  } catch (e) {
    console.warn("Lỗi revokeSession:", e);
  }
  return { success: true };
}

// 🌐 Xác thực Google ID Token và cấp phiên (Google SSO)
function verifyGoogleToken(credential, rememberMe) {
  try {
    if (!credential) {
      return { valid: false, error: "Thiếu mã xác thực Google (credential)." };
    }

    // 1. Gọi Google TokenInfo endpoint để kiểm tra tính hợp lệ và chữ ký số mật mã
    const verifyUrl = "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential);
    const response = UrlFetchApp.fetch(verifyUrl, { muteHttpExceptions: true });
    const code = response.getResponseCode();

    if (code !== 200) {
      console.warn("Google tokeninfo trả về lỗi:", response.getContentText());
      return { valid: false, error: "Xác thực tài khoản Google không thành công. Token không hợp lệ hoặc đã hết hạn." };
    }

    const payload = JSON.parse(response.getContentText());
    const email = (payload.email || '').toString().trim().toLowerCase();
    const emailVerified = payload.email_verified === "true" || payload.email_verified === true;

    if (!email || !emailVerified) {
      return { valid: false, error: "Email Google chưa được xác minh hoặc không hợp lệ." };
    }

    // 2. Tra cứu phân quyền người dùng trong sheet DanhSach
    const { teams, role } = getTeamsForEmail(email);
    if (teams.length === 0 && role !== 'Admin') {
      logAction(email, 'LOGIN_REJECTED', 'Tài khoản Google không có quyền trong hệ thống');
      return { valid: false, error: "Tài khoản (" + email + ") chưa được cấp quyền truy cập. Vui lòng liên hệ quản trị viên." };
    }

    // 3. Khởi tạo phiên làm việc bảo mật
    const isRemember = rememberMe !== false && rememberMe !== 'false';
    const token = Utilities.getUuid();
    savePersistentSession(token, email, role, isRemember);

    // GHI LOG ĐĂNG NHẬP GOOGLE
    logAction(email, 'LOGIN_GOOGLE', 'Đăng nhập Google SSO thành công (Ghi nhớ: ' + isRemember + ')');

    return { valid: true, token, email, teams, role };

  } catch (err) {
    console.error("Lỗi trong verifyGoogleToken:", err);
    return { valid: false, error: "Lỗi hệ thống khi xác thực Google: " + (err.message || err.toString()) };
  }
}

// 🔄 Xác minh phiên làm việc còn hiệu lực (Dành cho Auto-login khi tải trang)
function verifySession(token) {
  try {
    if (!token) return { valid: false, error: "Thiếu token." };

    const email = getEmailFromToken(token);
    if (!email) {
      return { valid: false, error: "Phiên làm việc đã hết hạn hoặc không tồn tại." };
    }

    const { teams, role } = getTeamsForEmail(email);
    if (teams.length === 0 && role !== 'Admin') {
      return { valid: false, error: "Tài khoản không còn quyền truy cập vào hệ thống." };
    }

    return { valid: true, token, email, teams, role };
  } catch (e) {
    console.error("Lỗi trong verifySession:", e);
    return { valid: false, error: "Lỗi kiểm tra phiên làm việc: " + (e.message || e.toString()) };
  }
}


// 📋 Lấy danh sách team & quyền được phép từ sheet "DanhSach"
function getTeamsForEmail(email) {
  try {
    const ss = SpreadsheetApp.openById(KEY_ACCOUNT_SHEET_ID);
    const sheet = ss.getSheetByName("DanhSach");
    if (!sheet) throw new Error("Sheet 'DanhSach' không tồn tại");

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { teams: [], role: 'User' };

    // Lấy dữ liệu 4 cột: A (Email), B (Teams), C (Ghi chú/Họ tên), D (Quyền)
    const data = sheet.getRange(2, 1, lastRow - 1, 4).getValues();

    for (let row of data) {
      let [storedEmail, teamsStr, colC, role] = row;
      if (storedEmail && storedEmail.toString().trim().toLowerCase() === email) {
        const teams = teamsStr ? teamsStr.toString().split(';').map(t => t.trim()).filter(t => t.length > 0) : [];
        const userRole = (role || 'User').toString().trim();
        return { teams, role: userRole };
      }
    }
    return { teams: [], role: 'User' };
  } catch (e) {
    console.error("Lỗi trong getTeamsForEmail:", e);
    return { teams: [], role: 'User' };
  }
}

// 🛡️ Kiểm tra xem token có phải là Admin không
function isAdmin(token) {
  const email = getEmailFromToken(token);
  if (!email) return false;
  const { role } = getTeamsForEmail(email);
  return role === 'Admin';
}


// 📊 Lấy dữ liệu đã lọc theo điều kiện — sử dụng SECURITY TOKEN (không tin tưởng email từ client)
function getFilteredData(options) {
  const { type, token, selectedTeams, fromYear, fromQuarter, toYear, toQuarter } = options;

  try {
    // 1. Kiểm tra Token & Lấy Email qua cơ chế Hierarchical Cache
    if (!token) return { success: false, error: "Thiếu token xác thực." };

    const email = getEmailFromToken(token);
    if (!email) {
      return { success: false, error: "Phiên làm việc đã hết hạn. Vui lòng tải lại trang và đăng nhập lại." };
    }

    // 2. Kiểm tra input khác
    if (!selectedTeams || !Array.isArray(selectedTeams) || selectedTeams.length === 0) {
      return { success: false, error: "Chưa chọn team nào." };
    }

    // 3. Kiểm tra quyền (Tái xác thực quyền của Email lấy từ Token)
    const { teams: allowedTeams, role } = getTeamsForEmail(email);

    // Nếu là Admin thì có quyền xem tất cả, nếu không thì phải check list
    if (role !== 'Admin') {
      const isAllAllowed = selectedTeams.every(t => allowedTeams.includes(t));
      if (!isAllAllowed) {
        return { success: false, error: "Phát hiện truy cập trái phép team không thuộc quyền quản lý." };
      }
    }

    // GHI LOG TRA CỨU (Lọc bỏ token ra khỏi log để bảo mật)
    const searchParams = { type, selectedTeams, fromYear, fromQuarter, toYear, toQuarter };
    logAction(email, 'SEARCH', JSON.stringify(searchParams));

    // Mở file DSTC
    const dstcSs = SpreadsheetApp.openById(DSTC_SHEET_ID);
    let sheet, allHeaders, data, result = [], filteredHeaders = [];

    if (type === 'ca_nhan') {
      sheet = dstcSs.getSheetByName("ChiTieu");
      if (!sheet) throw new Error("Sheet 'ChiTieu' không tồn tại");

      allHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      data = sheet.getRange(2, 1, Math.max(1, sheet.getLastRow() - 1), sheet.getLastColumn()).getValues();

      // Tìm vị trí cột M4 trong sheet ChiTieu theo tên header
      let m4ColIdx = -1;
      for (let i = 0; i < allHeaders.length; i++) {
        const hName = String(allHeaders[i] || '').trim().toLowerCase();
        if (hName === 'm4' || hName === 'muc 4' || hName === 'muc4' || hName === 'mức 4') {
          m4ColIdx = i;
          break;
        }
      }
      if (m4ColIdx === -1) m4ColIdx = 10; // Fallback cột K (index 10)

      // 1. Lọc các dòng thỏa mãn Team và Khoảng thời gian trước
      const matchedRows = [];
      let hasAnyM4 = false;

      // Cột: D=Team (index 3), E=Quý (index 4), F=Năm (index 5)
      for (let row of data) {
        const team = (row[3] || '').toString().trim();
        const quy = parseInt(row[4]) || 0;
        const nam = parseInt(row[5]) || 0;

        const teamMatches = selectedTeams.some(t => team.includes(t));
        if (teamMatches && isInRange(nam, quy, fromYear, fromQuarter, toYear, toQuarter)) {
          matchedRows.push(row);
          if (!hasAnyM4 && hasValidM4(row[m4ColIdx])) {
            hasAnyM4 = true;
          }
        }
      }

      // 2. Xác định danh sách cột cần lấy động
      // Mặc định không M4: [1, 2, 3, 4, 5, 7, 8, 9, 11, 12, 14]
      // Nếu có M4: chèn m4ColIdx vào giữa index 9 (M3) và index 11 (DSTC)
      let colsToKeep = [1, 2, 3, 4, 5, 7, 8, 9, 11, 12, 14];
      if (hasAnyM4) {
        colsToKeep = [1, 2, 3, 4, 5, 7, 8, 9, m4ColIdx, 11, 12, 14];
      }

      filteredHeaders = colsToKeep.map(i => (allHeaders[i] !== undefined ? allHeaders[i] : ''));

      // 3. Trích xuất dữ liệu
      for (let row of matchedRows) {
        const filteredRow = colsToKeep.map(i => row[i] !== undefined ? row[i] : '');
        result.push(filteredRow);
      }

    } else if (type === 'team') {
      sheet = dstcSs.getSheetByName("Team");
      if (!sheet) throw new Error("Sheet 'Team' không tồn tại");

      allHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      data = sheet.getRange(2, 1, Math.max(1, sheet.getLastRow() - 1), sheet.getLastColumn()).getValues();

      // Tìm vị trí cột M4 trong sheet Team theo tên header
      let m4ColIdx = -1;
      for (let i = 0; i < allHeaders.length; i++) {
        const hName = String(allHeaders[i] || '').trim().toLowerCase();
        if (hName === 'm4' || hName === 'muc 4' || hName === 'muc4' || hName === 'mức 4') {
          m4ColIdx = i;
          break;
        }
      }
      if (m4ColIdx === -1) m4ColIdx = 8; // Fallback

      // 1. Lọc các dòng thỏa mãn Team và Khoảng thời gian trước
      const matchedRows = [];
      let hasAnyM4 = false;

      // Cột: C=Team (index 2), B=Quý (index 1), A=Năm (index 0)
      for (let row of data) {
        const team = (row[2] || '').toString().trim();
        const quy = parseInt(row[1]) || 0;
        const nam = parseInt(row[0]) || 0;

        const teamMatches = selectedTeams.includes(team);
        if (teamMatches && isInRange(nam, quy, fromYear, fromQuarter, toYear, toQuarter)) {
          matchedRows.push(row);
          if (!hasAnyM4 && hasValidM4(row[m4ColIdx])) {
            hasAnyM4 = true;
          }
        }
      }

      // 2. Xác định danh sách cột cần lấy động
      // Mặc định đầy đủ: [0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11]
      // Nếu không có M4: lọc bỏ m4ColIdx
      const baseCols = [0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11];
      const colsToKeep = hasAnyM4
        ? baseCols
        : baseCols.filter(idx => idx !== m4ColIdx);

      filteredHeaders = colsToKeep.map(i => (allHeaders[i] !== undefined ? allHeaders[i] : ''));

      // 3. Trích xuất dữ liệu
      for (let row of matchedRows) {
        const filteredRow = colsToKeep.map(i => row[i] !== undefined ? row[i] : '');
        result.push(filteredRow);
      }

    } else {
      throw new Error("Loại tra cứu không hợp lệ");
    }

    // ✅ Trả về headers đã lọc + dữ liệu đã lọc
    return {
      success: true,
      headers: filteredHeaders,
      data: result
    };

  } catch (e) {
    console.error("Lỗi trong getFilteredData:", e);
    return { success: false, error: "Lỗi truy vấn dữ liệu: " + (e.message || e.toString()) };
  }
}


// 🔐 LẤY DANH SÁCH PHÂN QUYỀN (Dành cho Admin)
function getPermissionsList(token) {
  if (!isAdmin(token)) return { success: false, error: "Bạn không có quyền truy cập chức năng này." };

  try {
    const ss = SpreadsheetApp.openById(KEY_ACCOUNT_SHEET_ID);
    const sheet = ss.getSheetByName("DanhSach");
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true, data: [] };

    const data = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
    const result = data.map((row, index) => ({
      row: index + 2,
      email: row[0],
      teams: row[1],
      colC: row[2],
      role: row[3] || 'User'
    }));

    return { success: true, data: result };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// 🔐 LƯU/CẬP NHẬT PHÂN QUYỀN
function savePermission(token, pData) {
  if (!isAdmin(token)) return { success: false, error: "Bạn không có quyền thực hiện." };

  try {
    const ss = SpreadsheetApp.openById(KEY_ACCOUNT_SHEET_ID);
    const sheet = ss.getSheetByName("DanhSach");
    const lastRow = sheet.getLastRow();
    const data = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 1).getValues() : [];

    let rowIndex = -1;
    for (let i = 0; i < data.length; i++) {
      if (data[i][0].toString().trim().toLowerCase() === pData.email.trim().toLowerCase()) {
        rowIndex = i + 2;
        break;
      }
    }

    const rowValues = [pData.email, pData.teams, pData.colC, pData.role];

    if (rowIndex > 0) {
      sheet.getRange(rowIndex, 1, 1, 4).setValues([rowValues]);
    } else {
      sheet.appendRow(rowValues);
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// 🔐 XÓA PHÂN QUYỀN
function deletePermission(token, email) {
  if (!isAdmin(token)) return { success: false, error: "Bạn không có quyền thực hiện." };

  try {
    const ss = SpreadsheetApp.openById(KEY_ACCOUNT_SHEET_ID);
    const sheet = ss.getSheetByName("DanhSach");
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: false, error: "Không tìm thấy dữ liệu." };

    const data = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < data.length; i++) {
      if (data[i][0].toString().trim().toLowerCase() === email.trim().toLowerCase()) {
        sheet.deleteRow(i + 2);
        return { success: true };
      }
    }
    return { success: false, error: "Không tìm thấy email cần xóa." };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// 🌍 Lấy danh sách tất cả Team hiện có trong file DSTC (để Admin chọn khi phân quyền)
function getAllPossibleTeams(token) {
  if (!isAdmin(token)) return { success: false, error: "Không có quyền." };
  try {
    const dstcSs = SpreadsheetApp.openById(DSTC_SHEET_ID);
    const sheet = dstcSs.getSheetByName("Team");
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true, teams: [] };

    const data = sheet.getRange(2, 3, lastRow - 1, 1).getValues(); // Cột C là Team
    const teams = [...new Set(data.map(r => r[0].toString().trim()).filter(t => t))];
    return { success: true, teams: teams.sort() };
  } catch (e) {
    return { success: false, error: e.message };
  }
}


// 🔍 Kiểm tra giá trị M4 hợp lệ (khác rỗng, khác null/undefined, khác 0 và > 0)
function hasValidM4(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return value > 0;
  const str = String(value).trim();
  if (str === '' || str === '0') return false;
  const num = parseFloat(str.replace(/,/g, ''));
  if (!isNaN(num)) return num > 0;
  return true;
}

// ✅ Hàm so sánh QUÝ/NĂM — chuẩn
function isInRange(year, quarter, fromYear, fromQuarter, toYear, toQuarter) {
  const current = year * 10 + quarter;
  const start = fromYear * 10 + fromQuarter;
  const end = toYear * 10 + toQuarter;
  return current >= start && current <= end;
}

// 📝 GHI LOG HOẠT ĐỘNG
function logAction(email, action, details) {
  try {
    const ss = SpreadsheetApp.openById(KEY_ACCOUNT_SHEET_ID);
    let sheet = ss.getSheetByName("Logs");
    
    // Tự động tạo sheet Logs nếu chưa tồn tại
    if (!sheet) {
      sheet = ss.insertSheet("Logs");
      // Thêm header
      sheet.appendRow(["Thời gian", "Email", "Hành động", "Chi tiết"]);
      // Đóng băng dòng 1 và in đậm header
      sheet.setFrozenRows(1);
      sheet.getRange("A1:D1").setFontWeight("bold");
    }

    // Lấy thời gian hiện tại theo GMT+7
    const timestamp = Utilities.formatDate(new Date(), "GMT+7", "yyyy-MM-dd HH:mm:ss");
    
    // Ép kiểu các dữ liệu để an toàn khi ghi vào Sheet
    const safeEmail = (email || '').toString().trim();
    const safeAction = (action || '').toString().trim();
    const safeDetails = (details || '').toString().trim();

    sheet.appendRow([timestamp, safeEmail, safeAction, safeDetails]);
  } catch (e) {
    // Không ném lỗi ra ngoài để tránh sập tính năng chính của user
    console.error("Lỗi khi ghi logAction:", e.message, e);
  }
}

// 🧪 HÀM TEST NHANH GHI LOG (Chỉ dùng để test)
function testLog() {
  logAction("test@admicro.vn", "TEST_ACTION", "Kiểm tra tính năng ghi log");
  Logger.log("Đã chạy thử ghi log, vui lòng kiểm tra Sheet 'Logs' trong file KEY_ACCOUNT_SHEET_ID.");
}

// 🧪 HÀM TEST GỬI OTP & KÍCH HOẠT ỦY QUYỀN GOOGLE MAIL
function testSendOtp() {
  const testEmail = "caobuivan@vccorp.vn";
  Logger.log("=== BẮT ĐẦU TEST GỬI OTP TỚI: " + testEmail + " ===");
  const res = sendOtp(testEmail);
  Logger.log("Kết quả hàm sendOtp: " + JSON.stringify(res));
  Logger.log("Vui lòng kiểm tra Hòm thư Gmail và Sheet 'Logs'!");
}
