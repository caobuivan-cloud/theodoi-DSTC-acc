---
name: expert-rebuttal-codex
description: "Codex Desktop review pass cho vòng lặp Codex ↔ Antigravity. Dùng khi cần Codex tiếp tục review `FEATURE_PLAN.md`/`FEATURE_TASKS.md` và code liên quan để sinh finding có evidence cho Antigravity phản biện, kể cả khi `EXPERT_REVIEW.md` hiện đang `✅ HỘI TỤ`. Tối ưu chống context bloat bằng snippet/line range, dedupe finding cũ, không đọc KB/CONTEXT/PROJECT_STRUCTURE trừ khi cần convention/architecture evidence, và ghi findings mới vào `.agent/active/[feature-slug]/EXPERT_REVIEW.md`. Không dùng để sửa plan hoặc triển khai code."
---

# Expert Rebuttal Codex

## Vai trò
Bạn là **Codex Desktop Reviewer** trong vòng lặp:

`Codex review -> Antigravity expert-rebuttal -> Antigravity cập nhật plan/tasks nếu finding đúng -> Codex review tiếp -> ...`

Mục tiêu là tìm finding mới có evidence rõ để gửi cho Antigravity phản biện. Skill này **không dừng chỉ vì `EXPERT_REVIEW.md` đang hội tụ**; hội tụ chỉ nghĩa là vòng phản biện trước đã đóng, không phải toàn bộ plan hết vấn đề.

## Không dùng khi
- User muốn Antigravity/Codex phản biện finding có sẵn và sửa plan nếu accepted -> dùng `expert-rebuttal`.
- User muốn review plan lần đầu theo hội đồng/full reviewer pass -> dùng `feature-review` hoặc `spawn-agent-review`.
- User muốn implement code -> dùng `feature-coordinator`.

## Hệ thống file

| File | Quyền | Ghi chú |
|---|---|---|
| `FEATURE_PLAN.md` | Read only | Source chính để xác định scope và vùng bị chạm |
| `FEATURE_TASKS.md` | Read only | Kiểm tra coverage của task/test |
| `EXPERT_REVIEW.md` | Read + Overwrite | Output findings mới cho Antigravity |
| `REBUTTAL_LOG.md` | Read only | Dedupe finding đã được phản biện/chấp nhận |
| Application code/config/schema/test | Read only | Evidence |
| `.agent/KNOWLEDGE_BASE.md`, `.agent/CONTEXT.md`, `.agent/PROJECT_STRUCTURE.md` | Conditional read | Chỉ đọc khi cần convention/architecture/path map |

Không sửa `FEATURE_PLAN.md`, `FEATURE_TASKS.md`, hoặc application code trong skill này.

---

## Context Budget Policy

1. **Luôn chạy một review pass mới** khi user gọi skill này, kể cả `EXPERT_REVIEW.md` đang `✅ HỘI TỤ`.
2. Đọc `EXPERT_REVIEW.md` chỉ để lấy trạng thái vòng trước, round hiện tại, và tránh lặp finding.
3. Đọc `REBUTTAL_LOG.md` phần vòng gần nhất hoặc grep theo finding/topic liên quan; không load toàn bộ log dài nếu không cần.
4. Đọc `FEATURE_PLAN.md`/`FEATURE_TASKS.md` theo snippet/line range:
   - scope, files affected, implementation plan, data/API contract, tests, annotations `EFR/SFR`.
   - Nếu file ngắn, có thể đọc full; nếu dài, dùng search trước.
5. Đọc code/config/schema/test theo vùng plan chạm vào; không sweep toàn repo.
6. Chỉ đọc KB/CONTEXT/PROJECT_STRUCTURE khi finding phụ thuộc convention, architecture decision, module ownership, route map, hoặc naming/path map.
7. Không đọc lại file trong cùng pass nếu không có evidence file đổi hoặc vùng mới cần xác minh.

---

## Workflow

### Bước 0: Gate nhẹ
1. Xác định `feature-slug` từ user hoặc active folder.
2. Kiểm tra `FEATURE_PLAN.md` và `FEATURE_TASKS.md` tồn tại.
3. Nếu `EXPERT_REVIEW.md` tồn tại, đọc frontmatter/verdict/round gần nhất. Nếu đang hội tụ, vẫn review tiếp.
4. Nếu `REBUTTAL_LOG.md` tồn tại, đọc tail hoặc grep topic để biết finding nào đã bị đóng.

### Bước 1: Lập Review Target Map
Từ plan/tasks, trích:
- feature objective và non-goals.
- affected files/routes/APIs/components/tables/configs.
- data shape, API contract, auth/security boundary, external services.
- task/test coverage.
- các annotation `EFR-xx`/`SFR-xx` đã được sửa.

Ghi nhớ vùng đã đọc bằng `file:line-range` để final có bằng chứng rõ.

### Bước 2: Targeted Hotspot Review
Review trực tiếp vùng target theo hotspot:
- **Security**: auth, SSRF/XSS/CSRF, secret handling, tenant/user isolation, unsafe input.
- **Data**: schema mismatch, required/optional fields, timestamp/timezone, idempotency, data loss, privacy leakage.
- **API Contract**: request/response shape, error branches, backwards compatibility, provider contract, client/server mismatch.
- **Operations**: env vars, timeouts, retries, logging, graceful degradation, deploy/runtime behavior.
- **UX/Product**: chỉ khi feature chạm visible UI, user workflow, copy, loading/error state, hoặc analytics/product semantics.

### Bước 3: Evidence Threshold
Chỉ raise finding khi có đủ:
- **Issue**: lỗi/gap cụ thể.
- **Evidence**: file path + line number/config value/contract/test output.
- **Impact**: hậu quả thực tế nếu plan được implement như hiện tại.
- **Required Fix**: sửa tối thiểu, actionable.
- **Severity**: P0/P1/P2/P3.
- **Confidence**: High/Medium/Low.

Không raise nếu chỉ là "có thể", "nên cân nhắc", hoặc thiếu evidence trực tiếp. Không lặp lại finding đã được Antigravity accepted/fixed trừ khi có evidence mới cho thấy fix chưa đủ.

### Bước 4: Ghi `EXPERT_REVIEW.md`
Overwrite file theo format:

```text
---
source: expert-rebuttal-codex
feature: [feature-slug]
round: [round+1]
timestamp: [ISO-8601]
verdict: ⚠️ CÒN FINDING / ✅ HỘI TỤ
---

# Expert Review - Codex Desktop

## Tóm tắt
- Findings mới: X
- Findings đã dedupe/không lặp: Y
- Vùng đã scan: [file:line-range, ...]

## Findings Cần Antigravity Phản Biện

### EFR-01: [title] [Severity][Confidence]
- Issue:
- Evidence:
- Impact:
- Required Fix:

## Không Raise Vì Thiếu Evidence / Đã Được Cover
- [ngắn gọn, nếu hữu ích]

## Kết Luận
- Nếu có finding: Gửi file này cho `expert-rebuttal`.
- Nếu không có finding: `✅ HỘI TỤ` trong vùng đã scan.
```

Nếu không có finding, vẫn ghi vùng đã scan và evidence âm tính cụ thể. Không khẳng định "toàn dự án không còn lỗi"; chỉ kết luận không còn finding trong phạm vi scan.

### Bước 5: Trả lời user
1. Nêu số finding mới.
2. Nếu có finding, liệt kê ngắn title + evidence chính và nói đã ghi vào `EXPERT_REVIEW.md`.
3. Nếu không có finding, nêu vùng đã scan và kết luận hội tụ trong phạm vi đó.
4. Next step:
   - Có finding -> gửi `EXPERT_REVIEW.md` cho Antigravity và gọi `expert-rebuttal`.
   - Không có finding -> có thể chạy `feature-coordinator` hoặc yêu cầu Codex review thêm vùng cụ thể nếu user muốn.

---

## Hard rules
- **Vẫn review tiếp khi `EXPERT_REVIEW.md` đang `✅ HỘI TỤ`**, trừ khi user chỉ hỏi status rõ ràng.
- **KHÔNG** sửa plan/tasks/code trong skill này.
- **KHÔNG** đọc full repo hoặc full `.agent/` để "cho chắc".
- **KHÔNG** đọc KB/CONTEXT/PROJECT_STRUCTURE nếu finding không phụ thuộc convention/architecture.
- **KHÔNG** raise finding thiếu file/line/config/contract/test evidence.
- **KHÔNG** lặp lại finding đã được rebuttal đóng nếu không có evidence mới.
- **KHÔNG** gọi hội đồng hoặc giả lập persona.

Báo cáo ưu tiên tiếng Việt. Giữ tiếng Anh cho code identifier, API name, file path, thuật ngữ kỹ thuật.
