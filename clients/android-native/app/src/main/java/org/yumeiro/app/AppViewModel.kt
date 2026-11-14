package org.yumeiro.app

import android.app.Application
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.yumeiro.app.data.ApiClient
import org.yumeiro.app.data.ApiException
import org.yumeiro.app.data.HTTPS_UNSUPPORTED
import org.yumeiro.app.data.Session
import org.yumeiro.app.data.normalizeServer
import org.yumeiro.app.data.objects
import java.util.Calendar

data class MemoryItem(val id: String, val text: String, val pinned: Boolean, val kind: String)
data class AgentOpt(val id: String, val name: String, val description: String, val mine: Boolean, val systemPrompt: String = "", val model: String = "", val skillIds: List<String> = emptyList(), val shared: Boolean = false)
data class SkillItem(val id: String, val title: String, val description: String, val content: String, val shared: Boolean, val mine: Boolean)
data class MarketItem(val key: String, val type: String, val title: String, val description: String, val author: String, val installed: Boolean)
data class Member(val id: String, val email: String, val name: String, val disabled: Boolean, val todayCalls: Int, val monthCalls: Int, val tokens: Long)
data class Approval(val code: String, val ip: String, val ua: String, val expiresAt: Long)
data class McpItem(val name: String, val command: String, val enabled: Boolean)
data class Conv(val id: String, val title: String, val updatedAt: Long)
data class ModelOpt(val ref: String, val label: String, val provider: String)
data class AttRef(val id: String?, val name: String, val image: Boolean, val thumb: Bitmap? = null)
data class Msg(val key: Long, val role: String, val content: String, val atts: List<AttRef> = emptyList(), val error: Boolean = false)

/** 待发送的附件：上传进度、取消都在这里。 */
class Pending(val name: String, val image: Boolean, val size: Long, val thumb: Bitmap?) {
    var id by mutableStateOf("")
    var pct by mutableStateOf(0)
    var processing by mutableStateOf(false)
    var upload: ApiClient.Upload? = null
    @Volatile var cancelled = false
    val done get() = id.isNotEmpty()
}

enum class Screen { Loading, Login, Chat, Settings, Agents, Skills, Market, Admin, Security }

class AppViewModel(app: Application) : AndroidViewModel(app) {
    val session = Session(app)
    private val api = ApiClient(session)

    var screen by mutableStateOf(Screen.Loading); private set
    var loginBusy by mutableStateOf(false); private set
    var loginError by mutableStateOf("")
    var serverInput by mutableStateOf(session.server)
    var emailInput by mutableStateOf(session.email)
    var passwordInput by mutableStateOf("")
    var ignoreCertInput by mutableStateOf(session.ignoreCert)

    var me by mutableStateOf(JSONObject())
    val convs = mutableStateListOf<Conv>()
    val models = mutableStateListOf<ModelOpt>()
    var selectedModel by mutableStateOf("")
    var currentId by mutableStateOf<String?>(null)
    var title by mutableStateOf("新对话")
    val messages = mutableStateListOf<Msg>()
    val pending = mutableStateListOf<Pending>()
    var busy by mutableStateOf(false); private set
    var toast by mutableStateOf("")
    var usage by mutableStateOf("")
    val memories = mutableStateListOf<MemoryItem>()
    var memEnabled by mutableStateOf(true); var memAuto by mutableStateOf(true); var memCross by mutableStateOf(true)
    val agents = mutableStateListOf<AgentOpt>()
    var selectedAgent by mutableStateOf("")
    var fontScale by mutableStateOf(session.fontScale)
    var maxImages = 4; var maxFiles = 5; var maxImageMb = 8; var maxDocKb = 8192

    val skills = mutableStateListOf<SkillItem>()
    val market = mutableStateListOf<MarketItem>()
    val members = mutableStateListOf<Member>()
    val usageRows = mutableStateListOf<Member>()
    var usageMonth by mutableStateOf("")
    val mcp = mutableStateListOf<McpItem>()
    private var mcpRaw = JSONArray()
    var themeMode by mutableStateOf(session.themeMode)
    var wallpaper by mutableStateOf("")
    private var systemDark = (app.resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES
    val isAdmin get() = me.optString("role") == "admin"

    private var keySeq = 0L
    private var chatJob: Job? = null
    private val thumbCache = HashMap<String, Bitmap?>()

    init { applyTheme(); restore() }

    fun say(text: String) { toast = text }

    private fun <T> io(block: () -> T, onError: (ApiException) -> Unit = { say(it.message ?: "出错了") }, onOk: (T) -> Unit = {}) {
        viewModelScope.launch {
            try { val value = withContext(Dispatchers.IO) { block() }; onOk(value) }
            catch (e: ApiException) { if (e.status == 401) expired() else onError(e) }
            catch (e: Exception) { onError(ApiException(e.message ?: "出错了")) }
        }
    }

    private fun expired() { session.clearLogin(); passwordInput = ""; loginError = "登录已过期，请重新登录"; screen = Screen.Login }

    // ---- 登录 / 退出 ----
    private fun restore() {
        if (session.server.isEmpty() || session.cookies.isEmpty()) { screen = Screen.Login; return }
        viewModelScope.launch {
            try {
                val info = withContext(Dispatchers.IO) { api.checkSession() }
                if (info != null) { me = info; enterApp() } else { loginError = "登录已过期，请重新登录"; screen = Screen.Login }
            } catch (e: Exception) { loginError = (e.message ?: "连不上服务器") + "（请检查网络，或重新登录）"; screen = Screen.Login }
        }
    }

    fun login() {
        val server = normalizeServer(serverInput)
        if (server.isEmpty() || emailInput.isBlank() || passwordInput.isEmpty()) { loginError = "请填写服务器地址、邮箱和密码"; return }
        loginBusy = true; loginError = ""
        session.server = server; session.email = emailInput.trim(); session.ignoreCert = ignoreCertInput; session.cookies.clear(); session.csrf = ""; session.save()
        viewModelScope.launch {
            try {
                val typedScheme = serverInput.trim().startsWith("http", true)
                me = withContext(Dispatchers.IO) {
                    try { api.login(emailInput.trim(), passwordInput) }
                    catch (e: ApiException) {
                        if (!typedScheme && e.message?.startsWith(HTTPS_UNSUPPORTED) == true) { session.server = "http://" + server.removePrefix("https://"); session.save(); api.login(emailInput.trim(), passwordInput) } else throw e
                    }
                }
                passwordInput = ""; serverInput = session.server; enterApp()
            }
            catch (e: ApiException) { loginError = e.message ?: "登录失败" }
            catch (e: Exception) { loginError = e.message ?: "登录失败" }
            finally { loginBusy = false }
        }
    }

    fun logout() {
        stop()
        viewModelScope.launch { withContext(Dispatchers.IO) { api.logout() }; convs.clear(); messages.clear(); pending.clear(); currentId = null; title = "新对话"; me = JSONObject(); org.yumeiro.app.ui.Pal.wallpaper = null; org.yumeiro.app.ui.Pal.gradient = null; screen = Screen.Login }
    }

    private fun enterApp() {
        screen = Screen.Chat
        loadConvs(); loadModels(); loadConfig(); loadUsage(); loadAgents(); loadMemories(); loadWallpaperPrefs()
    }

    // ---- 数据 ----
    fun loadConvs() = io({ api.call("GET", "/api/conversations").optJSONArray("conversations") ?: JSONArray() }) { arr ->
        convs.clear(); convs.addAll(arr.objects().map { Conv(it.optString("id"), it.optString("title").ifBlank { "新对话" }, it.optLong("updatedAt")) }.sortedByDescending { it.updatedAt })
    }

    private fun loadModels() = io({ api.call("GET", "/api/models") }) { data ->
        val list = (data.optJSONArray("models") ?: JSONArray()).objects().map { ModelOpt(it.optString("ref"), it.optString("label").ifBlank { it.optString("model") }.ifBlank { it.optString("ref") }, it.optString("providerName")) }
        models.clear(); models.addAll(list)
        val wanted = listOf(session.defaultModel, data.optString("defaultModel")).firstOrNull { w -> w.isNotEmpty() && list.any { it.ref == w } } ?: list.firstOrNull()?.ref ?: ""
        if (selectedModel.isEmpty() || list.none { it.ref == selectedModel }) selectedModel = wanted
    }

    private fun loadConfig() = io({ api.call("GET", "/api/vision/config") }, onError = {}) { c ->
        maxImages = c.optInt("maxImages", 4); maxFiles = c.optInt("maxFiles", 5); maxImageMb = c.optInt("maxMb", 8); maxDocKb = c.optInt("maxDocKb", 8192)
    }

    fun loadUsage() = io({ api.call("GET", "/api/usage/me") }, onError = {}) { d ->
        val u = d.optJSONObject("usage") ?: JSONObject()
        usage = "本月 ${u.optInt("calls")}" + (u.optInt("monthlyCallLimit").takeIf { it > 0 }?.let { " / $it" } ?: "") + " 次"
    }

    fun loadAgents() = io({ api.call("GET", "/api/agents") }, onError = {}) { d ->
        agents.clear(); agents.addAll((d.optJSONArray("agents") ?: JSONArray()).objects().map { AgentOpt(it.optString("id"), it.optString("name"), it.optString("description"), it.optBoolean("mine"), it.optString("systemPrompt"), it.optString("model"), (it.optJSONArray("skillIds") ?: JSONArray()).let { a -> (0 until a.length()).map { i -> a.optString(i) } }, it.optBoolean("shared")) })
        if (agents.none { it.id == selectedAgent }) selectedAgent = ""
    }

    fun loadMemories() = io({ api.call("GET", "/api/memories") }, onError = {}) { d ->
        memories.clear(); memories.addAll((d.optJSONArray("memories") ?: JSONArray()).objects().map { MemoryItem(it.optString("id"), it.optString("text"), it.optBoolean("pinned"), it.optString("kind")) })
        d.optJSONObject("prefs")?.let { memEnabled = it.optBoolean("enabled", true); memAuto = it.optBoolean("auto", true); memCross = it.optBoolean("crossChat", true) }
    }

    fun setMemPref(key: String, value: Boolean) {
        when (key) { "enabled" -> memEnabled = value; "auto" -> memAuto = value; "crossChat" -> memCross = value }
        io({ api.call("PUT", "/api/memory/prefs", JSONObject().put(key, value)) }, onError = { say(it.message ?: "保存失败"); loadMemories() })
    }

    fun addMemory(text: String) = io({ api.call("POST", "/api/memories", JSONObject().put("text", text).put("kind", "note")) }) { loadMemories(); say("已记住") }
    fun deleteMemory(id: String) = io({ api.call("DELETE", "/api/memories/$id") }) { memories.removeAll { it.id == id } }
    fun clearMemories() = io({ api.call("DELETE", "/api/memories") }) { memories.clear(); say("已清空记忆") }

    fun changePassword(old: String, new: String, done: (String?) -> Unit) {
        if (new.length < 16) { done("新密码至少需要 16 个字符"); return }
        io({ api.call("POST", "/api/auth/change-password", JSONObject().put("currentPassword", old).put("newPassword", new)) }, onError = { done(it.message ?: "修改失败") }) { done(null); say("密码已修改，其它设备需要重新登录") }
    }

    fun chooseAgent(id: String) { selectedAgent = id }

    // ---- 主题 / 壁纸 ----
    fun applyTheme() { org.yumeiro.app.ui.Pal.dark = when (themeMode) { "dark" -> true; "light" -> false; else -> systemDark } }
    fun setSystemDark(value: Boolean) { systemDark = value; applyTheme() }
    fun setTheme(mode: String) { themeMode = mode; session.themeMode = mode; session.save(); applyTheme() }
    // 壁纸和网页版、Windows 版共用服务器上的设置（/api/wallpapers）：选了什么、遮罩多暗，换设备也一样
    class WallItem(val name: String, val kind: String)
    val wallItems = mutableStateListOf<WallItem>()
    var wallDim by mutableStateOf(35)
    private var wallDefault = ""
    fun loadWallpaperPrefs() = io({ api.call("GET", "/api/wallpapers") }, onError = {}) { d ->
        wallItems.clear(); wallItems.addAll((d.optJSONArray("items") ?: JSONArray()).objects().map { WallItem(it.optString("name"), it.optString("kind")) })
        val pref = d.optJSONObject("pref"); wallDefault = d.optString("defaultWallpaper")
        wallpaper = if (pref == null || pref.isNull("wallpaper")) wallDefault else pref.optString("wallpaper")
        wallDim = pref?.optInt("dim", 35) ?: 35
        showWallpaper()
    }
    fun chooseWallpaper(name: String) {
        wallpaper = name; showWallpaper()
        io({ api.call("PUT", "/api/wallpapers/pref", JSONObject().put("wallpaper", name).put("dim", wallDim)) }, onError = { say(it.message ?: "保存壁纸失败") })
    }
    fun chooseWallDim(dim: Int) {
        wallDim = dim; org.yumeiro.app.ui.Pal.dim = dim
        io({ api.call("PUT", "/api/wallpapers/pref", JSONObject().put("wallpaper", wallpaper).put("dim", dim)) }, onError = { say(it.message ?: "保存失败") })
    }
    private fun showWallpaper() {
        val pal = org.yumeiro.app.ui.Pal; pal.dim = wallDim
        val preset = org.yumeiro.app.ui.WALL_PRESETS.firstOrNull { "preset:" + it.id == wallpaper }
        pal.gradient = preset?.colors
        val name = if (wallpaper == "preset:slideshow") wallItems.firstOrNull { it.kind == "image" }?.name ?: "" else wallpaper
        val file = wallItems.firstOrNull { it.name == name && it.kind == "image" }
        if (preset != null || file == null) { pal.wallpaper = null; return }
        viewModelScope.launch {
            val bmp = withContext(Dispatchers.IO) { runCatching {
                val data = api.bytes("/api/wallpapers/file/" + java.net.URLEncoder.encode(file.name, "UTF-8"), 12 * 1024 * 1024).second
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }; BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
                var sample = 1; while (bounds.outWidth / sample > 1600 || bounds.outHeight / sample > 1600) sample *= 2
                BitmapFactory.decodeByteArray(data, 0, data.size, BitmapFactory.Options().apply { inSampleSize = sample })
            }.getOrNull() }
            if (name == (if (wallpaper == "preset:slideshow") file.name else wallpaper)) pal.wallpaper = bmp?.asImageBitmap()
        }
    }

    // ---- 智能体 ----
    fun saveAgent(id: String?, name: String, description: String, prompt: String, model: String, skillIds: List<String>, shared: Boolean, done: (String?) -> Unit) {
        val body = JSONObject().put("name", name).put("description", description).put("systemPrompt", prompt).put("model", model).put("skillIds", JSONArray(skillIds)).apply { if (isAdmin) put("shared", shared) }
        io({ if (id == null) api.call("POST", "/api/agents", body) else api.call("PATCH", "/api/agents/$id", body) }, onError = { done(it.message ?: "保存失败") }) { loadAgents(); done(null) }
    }
    fun deleteAgent(id: String) = io({ api.call("DELETE", "/api/agents/$id") }) { if (selectedAgent == id) selectedAgent = ""; loadAgents() }

    // ---- 技能 / 市场 ----
    fun loadSkills() = io({ api.call("GET", "/api/skills") }) { d ->
        skills.clear(); skills.addAll((d.optJSONArray("skills") ?: JSONArray()).objects().map { SkillItem(it.optString("id"), it.optString("title"), it.optString("description"), it.optString("content"), it.optBoolean("shared"), it.optBoolean("mine")) })
    }
    fun saveSkill(id: String?, title: String, description: String, content: String, shared: Boolean, done: (String?) -> Unit) {
        val body = JSONObject().put("title", title).put("description", description).put("content", content).apply { if (isAdmin) put("shared", shared) }
        io({ if (id == null) api.call("POST", "/api/skills", body) else api.call("PATCH", "/api/skills/$id", body) }, onError = { done(it.message ?: "保存失败") }) { loadSkills(); loadAgents(); done(null) }
    }
    fun deleteSkill(id: String) = io({ api.call("DELETE", "/api/skills/$id") }) { loadSkills(); loadAgents() }
    fun loadMarket() = io({ api.call("GET", "/api/market") }) { d ->
        fun parse(a: JSONArray?) = (a ?: JSONArray()).objects().map { MarketItem(it.optString("key"), it.optString("type"), it.optString("title"), it.optString("description"), it.optString("author"), it.optBoolean("installed")) }
        market.clear(); market.addAll(parse(d.optJSONArray("skills")) + parse(d.optJSONArray("bots")))
    }
    var previewItem by mutableStateOf<MarketItem?>(null); var previewText by mutableStateOf("")
    fun previewMarket(item: MarketItem) {
        previewItem = item; previewText = "正在读取…"
        io({ api.call("GET", "/api/market/preview?key=" + java.net.URLEncoder.encode(item.key, "UTF-8")) }, onError = { previewText = it.message ?: "读取失败" }) { previewText = it.optString("preview").ifBlank { "（没有内容）" } }
    }
    suspend fun translate(text: String): String = withContext(Dispatchers.IO) { api.call("POST", "/api/translate", JSONObject().put("text", text)).optString("text") }
    fun installMarket(item: MarketItem) = io({ api.call("POST", "/api/market/install", JSONObject().put("key", item.key).put("type", item.type)) }) { say("已安装：" + item.title); loadMarket(); loadSkills(); loadAgents() }

    // ---- 网页找回密码的手机确认（仅管理员）----
    val approvals = mutableStateListOf<Approval>()
    fun loadApprovals() = io({ api.call("GET", "/api/security/recovery") }, onError = {}) { d ->
        approvals.clear(); approvals.addAll((d.optJSONArray("pending") ?: JSONArray()).objects().map { Approval(it.optString("code"), it.optString("ip"), it.optString("ua"), it.optLong("expiresAt")) })
    }
    /** code 是网页上显示的 6 位验证码；approve=false 表示拒绝 */
    fun decideApproval(code: String, approve: Boolean, done: (String?) -> Unit) =
        io({ api.call("POST", "/api/security/phone-approve", JSONObject().put("code", code.filter { it.isDigit() }).put("approve", approve)) }, onError = { done(it.message ?: "操作失败") }) {
            done(null); say(if (approve) "已批准，网页那边会自动继续" else "已拒绝这次请求"); loadApprovals()
        }

    // ---- 管理（仅管理员）----
    private fun parseMember(it: JSONObject) = Member(it.optString("id"), it.optString("email"), it.optString("displayName").ifBlank { it.optString("email") }, it.optBoolean("disabled"), it.optInt("todayCalls"), it.optJSONObject("month")?.optInt("calls") ?: it.optInt("calls"), it.optJSONObject("month")?.optLong("totalTokens") ?: it.optLong("totalTokens"))
    fun loadMembers() = io({ api.call("GET", "/api/admin/members") }) { d -> members.clear(); members.addAll((d.optJSONArray("members") ?: JSONArray()).objects().map { parseMember(it) }) }
    fun createMember(email: String, name: String, password: String, done: (String?) -> Unit) =
        io({ api.call("POST", "/api/admin/members", JSONObject().put("email", email).put("displayName", name).put("password", password)) }, onError = { done(it.message ?: "创建失败") }) { loadMembers(); done(null) }
    fun setMemberDisabled(id: String, disabled: Boolean) = io({ api.call("PATCH", "/api/admin/members/$id", JSONObject().put("disabled", disabled)) }) { loadMembers() }
    fun resetMemberPassword(id: String, password: String, done: (String?) -> Unit) =
        io({ api.call("PATCH", "/api/admin/members/$id", JSONObject().put("password", password)) }, onError = { done(it.message ?: "修改失败") }) { say("密码已重置，该成员需重新登录"); done(null) }
    fun deleteMember(id: String) = io({ api.call("DELETE", "/api/admin/members/$id") }) { loadMembers() }
    fun loadUsageAll() = io({ api.call("GET", "/api/admin/usage") }) { d ->
        usageMonth = d.optString("month"); usageRows.clear(); usageRows.addAll((d.optJSONArray("rows") ?: JSONArray()).objects().map { parseMember(it).copy(monthCalls = it.optInt("calls"), tokens = it.optLong("totalTokens")) })
    }
    fun loadMcp() = io({ api.call("GET", "/api/admin/mcp") }) { d ->
        mcpRaw = d.optJSONArray("servers") ?: JSONArray(); mcp.clear(); mcp.addAll(mcpRaw.objects().map { McpItem(it.optString("name"), it.optString("command") + " " + (it.optJSONArray("args")?.let { a -> (0 until a.length()).joinToString(" ") { i -> a.optString(i) } } ?: ""), it.optBoolean("enabled", true)) })
    }
    fun toggleMcp(name: String, enabled: Boolean) {
        val copy = JSONArray(mcpRaw.toString()); for (i in 0 until copy.length()) copy.getJSONObject(i).let { if (it.optString("name") == name) it.put("enabled", enabled) }
        io({ api.call("PUT", "/api/admin/mcp", JSONObject().put("servers", copy)) }) { loadMcp(); say(if (enabled) "已启用 $name" else "已停用 $name") }
    }
    fun setFont(scale: Float) { fontScale = scale; session.fontScale = scale; session.save() }

    fun chooseModel(ref: String) { selectedModel = ref; session.defaultModel = ref; session.save() }

    // ---- 对话 ----
    fun newChat() { if (busy) return; currentId = null; title = "新对话"; messages.clear() }

    fun openConv(id: String) {
        if (busy) return
        io({ api.call("GET", "/api/conversations/$id") }) { d ->
            currentId = id; title = d.optJSONObject("conversation")?.optString("title").orEmpty().ifBlank { "新对话" }
            d.optJSONObject("conversation")?.optString("model")?.let { m -> if (m.isNotEmpty() && models.any { it.ref == m }) selectedModel = m }
            messages.clear()
            for (m in (d.optJSONArray("messages") ?: JSONArray()).objects()) {
                val atts = (m.optJSONArray("images") ?: JSONArray()).objects().map { AttRef(it.optString("id"), it.optString("name").ifBlank { "图片" }, true) } +
                    (m.optJSONArray("files") ?: JSONArray()).objects().map { AttRef(it.optString("id"), it.optString("name").ifBlank { "文件" }, false) }
                messages.add(Msg(keySeq++, if (m.optString("role") == "user") "user" else "assistant", m.optString("content"), atts))
            }
        }
    }

    fun renameConv(newTitle: String) {
        val id = currentId ?: return; val t = newTitle.trim().take(60); if (t.isEmpty()) return
        io({ api.call("PATCH", "/api/conversations/$id", JSONObject().put("title", t)) }) { title = t; loadConvs() }
    }

    fun deleteConv(id: String) {
        io({ api.call("DELETE", "/api/conversations/$id") }) { if (currentId == id) newChat(); loadConvs() }
    }

    fun transcript(): String = messages.joinToString("\n\n") { (if (it.role == "user") "## 我\n" else "## Yumeiro\n") + it.content }

    // ---- 附件 ----
    fun addUris(uris: List<Uri>) {
        val resolver = getApplication<Application>().contentResolver
        for (uri in uris) {
            val name = runCatching { resolver.query(uri, null, null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(c.getColumnIndexOrThrow(OpenableColumns.DISPLAY_NAME)) else null } }.getOrNull() ?: "文件"
            val type = resolver.getType(uri) ?: ""
            val image = type in listOf("image/png", "image/jpeg", "image/webp", "image/gif")
            val same = pending.count { it.image == image }
            if (image && same >= maxImages) { say("一条消息最多带 $maxImages 张图片"); continue }
            if (!image && same >= maxFiles) { say("一条消息最多带 $maxFiles 个文件"); continue }
            viewModelScope.launch {
                val data = withContext(Dispatchers.IO) { runCatching { resolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull() }
                if (data == null || data.isEmpty()) { say("$name：读取失败或文件是空的"); return@launch }
                val limit = if (image) maxImageMb * 1048576L else maxDocKb * 1024L
                if (data.size > limit) { say("$name：太大了（上限 ${limit / 1048576} MB）"); return@launch }
                val thumb = if (image) withContext(Dispatchers.Default) { decodeThumb(data) } else null
                val item = Pending(name, image, data.size.toLong(), thumb); pending.add(item)
                withContext(Dispatchers.IO) {
                    try {
                        val att = api.upload(name, data, onStart = { item.upload = it }, onProgress = { sent, total -> item.pct = (sent * 100 / total).toInt().coerceAtMost(99); if (sent >= total) item.processing = true })
                        if (item.cancelled) { runCatching { api.call("DELETE", "/api/attachments/${att.optString("id")}") } } else item.id = att.optString("id")
                    } catch (e: ApiException) {
                        withContext(Dispatchers.Main) { pending.remove(item); if (e.status == 401) expired() else if (!item.cancelled) say("$name：${e.message}") }
                    }
                }
            }
        }
    }

    fun removePending(item: Pending) {
        pending.remove(item)
        if (item.done) io({ api.call("DELETE", "/api/attachments/${item.id}") }, onError = {})
        else { item.cancelled = true; item.upload?.cancel() }
    }

    private fun decodeThumb(data: ByteArray): Bitmap? = runCatching {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }; BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
        var sample = 1; while (bounds.outWidth / sample > 600 || bounds.outHeight / sample > 600) sample *= 2
        BitmapFactory.decodeByteArray(data, 0, data.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }.getOrNull()

    /** 历史消息里的图片：向服务器取（带登录状态），缓存缩略图。 */
    suspend fun loadAttachmentImage(id: String): Bitmap? {
        if (thumbCache.containsKey(id)) return thumbCache[id]
        val bitmap = withContext(Dispatchers.IO) { runCatching { decodeThumb(api.bytes("/api/attachments/$id").second) }.getOrNull() }
        thumbCache[id] = bitmap; return bitmap
    }

    suspend fun loadAttachmentText(id: String): String = withContext(Dispatchers.IO) {
        try { api.bytes("/api/attachments/$id").second.toString(Charsets.UTF_8) } catch (e: ApiException) { "读取失败：${e.message}" }
    }

    // ---- 发送 ----
    fun send(raw: String) {
        if (busy) return
        val text0 = raw.trim()
        val ready = pending.filter { it.done }
        if (text0.isEmpty() && ready.isEmpty()) return
        if (pending.any { !it.done }) { say("附件还在上传，请稍候"); return }
        if (models.isEmpty()) { say("服务器还没有配置模型，请联系管理员"); return }
        val text = text0.ifEmpty { if (ready.all { !it.image }) "请阅读我上传的文件，并总结其中的要点。" else "请看这张图片，描述并分析其中的内容。" }
        val sentAtts = ready.map { it.id }; val shown = ready.map { AttRef(it.id, it.name, it.image, it.thumb) }
        pending.clear()
        busy = true
        chatJob = viewModelScope.launch {
            var assistantIndex = -1
            try {
                if (currentId == null) {
                    val c = withContext(Dispatchers.IO) { api.call("POST", "/api/conversations", JSONObject().put("model", selectedModel).apply { if (selectedAgent.isNotEmpty()) put("agent_id", selectedAgent) }) }
                    val conv = c.optJSONObject("conversation") ?: throw ApiException("创建对话失败")
                    currentId = conv.optString("id"); convs.add(0, Conv(currentId!!, conv.optString("title").ifBlank { "新对话" }, System.currentTimeMillis()))
                }
                messages.add(Msg(keySeq++, "user", text, shown)); messages.add(Msg(keySeq++, "assistant", "")); assistantIndex = messages.lastIndex
                var acc = ""
                val body = JSONObject().put("conversation_id", currentId).put("message", text).apply { if (sentAtts.isNotEmpty()) put("attachments", JSONArray(sentAtts)) }
                var failed: String? = null
                withContext(Dispatchers.IO) {
                    api.stream("/api/chat/stream", body) { event, data ->
                        when (event) {
                            "delta" -> { acc += data.optString("text"); val snapshot = acc; viewModelScope.launch { if (assistantIndex in messages.indices) messages[assistantIndex] = messages[assistantIndex].copy(content = snapshot) } }
                            "error" -> failed = data.optString("error").ifBlank { "回复失败" }
                            "done" -> data.optJSONObject("conversation")?.optString("title")?.takeIf { it.isNotBlank() }?.let { t -> viewModelScope.launch { title = t } }
                        }
                    }
                }
                if (failed != null && assistantIndex in messages.indices) messages[assistantIndex] = messages[assistantIndex].copy(content = failed!!, error = true)
            } catch (e: ApiException) {
                if (e.status == 401) expired()
                else if (assistantIndex in messages.indices) messages[assistantIndex] = messages[assistantIndex].copy(content = e.message ?: "请求失败", error = true) else say(e.message ?: "请求失败")
            } catch (e: kotlinx.coroutines.CancellationException) { throw e }
            catch (e: Exception) { if (assistantIndex in messages.indices) messages[assistantIndex] = messages[assistantIndex].copy(content = e.message ?: "请求失败", error = true) }
            finally { busy = false; loadConvs(); loadUsage() }
        }
    }

    fun stop() { api.cancelStream() }

    // ---- 分组 ----
    fun grouped(): List<Pair<String, List<Conv>>> {
        val cal = Calendar.getInstance(); cal.set(Calendar.HOUR_OF_DAY, 0); cal.set(Calendar.MINUTE, 0); cal.set(Calendar.SECOND, 0); cal.set(Calendar.MILLISECOND, 0)
        val today = cal.timeInMillis; val day = 86400000L
        fun label(t: Long) = if (t >= today) "今天" else if (t >= today - day) "昨天" else if (t >= today - 7 * day) "最近 7 天" else "更早"
        val out = LinkedHashMap<String, MutableList<Conv>>()
        for (c in convs) out.getOrPut(label(c.updatedAt)) { mutableListOf() }.add(c)
        return out.map { it.key to it.value }
    }

    fun openSettings() { screen = Screen.Settings }
    fun open(s: Screen) { screen = s }
    fun closeSettings() { screen = Screen.Chat }
}
