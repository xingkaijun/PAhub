# 最新验收结果

45 PASS / 3 FAIL / 0 BLOCKED；48 项。

截图 36 张，合计 7.08 MiB，无损重压缩 PNG。

|角色|路径 / 行为|结果|证据|
|---|---|---|---|
| environment | production proxy refuses startup | PASS | HTTP / runner assertion |
| viewer | list and PCF visible | PASS | [PNG](t5-01-viewer-list-and-PCF-visible.png) |
| viewer | banner name and role | PASS | [PNG](t5-02-viewer-banner-name-and-role.png) |
| viewer | Change password and Sign out destinations | PASS | [PNG](t5-03-viewer-Change-password-and-Sign-out-destinations.png) |
| viewer | SSE presence uses verified name | PASS | [PNG](t5-04-viewer-SSE-presence-uses-verified-name.png) |
| reviewer | list and PCF visible | PASS | [PNG](t5-05-reviewer-list-and-PCF-visible.png) |
| reviewer | banner name and role | PASS | [PNG](t5-06-reviewer-banner-name-and-role.png) |
| reviewer | Change password and Sign out destinations | PASS | [PNG](t5-07-reviewer-Change-password-and-Sign-out-destinations.png) |
| reviewer | SSE presence uses verified name | PASS | [PNG](t5-08-reviewer-SSE-presence-uses-verified-name.png) |
| manager | list and PCF visible | PASS | [PNG](t5-09-manager-list-and-PCF-visible.png) |
| manager | banner name and role | PASS | [PNG](t5-10-manager-banner-name-and-role.png) |
| manager | Change password and Sign out destinations | PASS | [PNG](t5-11-manager-Change-password-and-Sign-out-destinations.png) |
| manager | SSE presence uses verified name | PASS | [PNG](t5-12-manager-SSE-presence-uses-verified-name.png) |
| admin | list and PCF visible | PASS | [PNG](t5-13-admin-list-and-PCF-visible.png) |
| admin | banner name and role | PASS | [PNG](t5-14-admin-banner-name-and-role.png) |
| admin | Change password and Sign out destinations | PASS | [PNG](t5-15-admin-Change-password-and-Sign-out-destinations.png) |
| admin | SSE presence uses verified name | PASS | [PNG](t5-16-admin-SSE-presence-uses-verified-name.png) |
| viewer | all write controls hidden | FAIL | [PNG](t5-17-viewer-all-write-controls-hidden.png) |
| viewer | direct write rejected | PASS | HTTP / runner assertion |
| reviewer | new opinion auto initiator and read-only | PASS | [PNG](t5-18-reviewer-new-opinion-auto-initiator-and-read-only.png) |
| reviewer | edit own opinion | PASS | [PNG](t5-19-reviewer-edit-own-opinion.png) |
| reviewer | edit other opinion rejected | PASS | HTTP / runner assertion |
| reviewer | drawing status rejected | PASS | HTTP / runner assertion |
| manager | update drawing status through UI | PASS | [PNG](t5-20-manager-update-drawing-status-through-UI.png) |
| manager | update assignee through UI | FAIL | [PNG](t5-21-manager-update-assignee-through-UI.png) |
| manager | update remark through command UI | PASS | HTTP / runner assertion |
| manager | edit other opinion through PCF | PASS | [PNG](t5-23-manager-edit-other-opinion-through-PCF.png) |
| manager | designate another initiator | PASS | [PNG](t5-24-manager-designate-another-initiator.png) |
| manager | single Export to Builder preserves status | PASS | [PNG](t5-25-manager-single-Export-to-Builder-preserves-status.png) |
| manager | Team Setup rejected | PASS | [PNG](t5-26-manager-Team-Setup-rejected.png) |
| admin | Team Setup selects directory reviewer | PASS | [PNG](t5-27-admin-Team-Setup-selects-directory-reviewer.png) |
| admin | Settings available | PASS | [PNG](t5-28-admin-Settings-available.png) |
| admin | create project via lobby | FAIL | [PNG](t5-29-admin-create-project-via-lobby.png) |
| manager | Builder import transition Pending | PASS | HTTP / runner assertion |
| manager | Builder import transition Reviewing | PASS | HTTP / runner assertion |
| manager | Builder import transition Waiting Reply | PASS | HTTP / runner assertion |
| manager | Builder import transition Approved | PASS | HTTP / runner assertion |
| viewer | Daily Log Actor column and filter | PASS | [PNG](t5-30-viewer-Daily-Log-Actor-column-and-filter.png) |
| reviewer | Daily Log Actor column and filter | PASS | [PNG](t5-31-reviewer-Daily-Log-Actor-column-and-filter.png) |
| manager | Daily Log Actor column and filter | PASS | [PNG](t5-32-manager-Daily-Log-Actor-column-and-filter.png) |
| admin | Daily Log Actor column and filter | PASS | [PNG](t5-33-admin-Daily-Log-Actor-column-and-filter.png) |
| security | forged expired wrong-audience direct backend rejected | PASS | HTTP / runner assertion |
| security | cross-Origin write rejected | PASS | HTTP / runner assertion |
| security | proxy overwrites supplied identity | PASS | HTTP / runner assertion |
| security | uploaded HTML cannot execute for admin | PASS | HTTP / runner assertion |
| admin | directory unavailable manual fallback | PASS | [PNG](t5-35-admin-directory-unavailable-manual-fallback.png) |
| legacy | administrator password login and PCF | PASS | [PNG](t5-36-legacy-administrator-password-login-and-PCF.png) |
| legacy | Builder reply file attachment | PASS | HTTP / runner assertion |
