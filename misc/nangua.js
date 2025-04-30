"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = require("axios");
const CryptoJs = require("crypto-js");
const he = require("he");
const qs = require('qs');

const pageSize = 50;
const LYRICS_API_BASE_URL = 'https://lrc.xms.mx';
const ALL_PLAYLISTS_TAG = { id: 'navidrome__all_playlists', title: '在线歌单' };
const ALL_SONGS_TAG = { id: 'navidrome__all_songs', title: '所有歌曲' };

// https://gitee.com/Rrance/WP/raw/master/%E5%8D%97%E7%93%9C.js
// --- 导入相关常量 ---
const QQ_MATCH_RESULT_COUNT = 10;
const QQ_IMPORT_CONCURRENCY = 5;
const NCM_IMPORT_CONCURRENCY = 10;
const NCM_MATCH_RESULT_COUNT = 10;
const DURATION_TOLERANCE_SECONDS = 5;

// 在顶部合适位置添加
function getUserAgent() {
    // 浏览器环境
    if (typeof navigator !== 'undefined' && navigator.userAgent) {
        if (/Android/i.test(navigator.userAgent)) return 'Mozilla/5.0 (Linux; Android 14.0; Mobile; rv:112.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 MusicFree/0.5.1';
        if (/Windows/i.test(navigator.userAgent)) return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 MusicFree/0.0.7';
        if (/Linux/i.test(navigator.userAgent)) return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 MusicFree/0.0.7';
        return 'MusicFree/Web';
    }
    // Node.js 环境
    if (typeof process !== 'undefined' && process.platform) {
        if (process.platform === 'win32') return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 MusicFree/0.0.7';
        if (process.platform === 'android') return 'Mozilla/5.0 (Linux; Android 14.0; Mobile; rv:112.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 MusicFree/0.5.1';
        if (process.platform === 'linux') return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 MusicFree/0.0.7';
        return 'MusicFree/' + process.platform;
    }
    return 'MusicFree/Unknown';
}


// --- 统一获取用户变量和认证参数 ---
function getUserVariables() {
    return (env?.getUserVariables && env.getUserVariables()) || {};
}
function getAuthParams() {
    const { username, password } = getUserVariables();
    const salt = Math.random().toString(16).slice(2);
    const token = CryptoJs.MD5(`${password}${salt}`).toString(CryptoJs.enc.Hex);
    return { u: username, s: salt, t: token, c: "MusicFree", v: "1.16.1", f: "json" };
}

function deduplicateTracks(tracks) {
    const seen = new Set();
    return tracks.filter(track => {
        if (!track.id) return false;
        if (seen.has(track.id)) return false;
        seen.add(track.id);
        return true;
    });
}

// --- Native Token 缓存 ---
let nativeTokenCache = { token: null, time: 0 };
async function getNativeToken() {
    const { url, username, password } = getUserVariables();
    if (!url || !username || !password) return null;
    const now = Date.now();
    // 如果 token 快到期，后台异步刷新
    if (nativeTokenCache.token && now - nativeTokenCache.time > 3 * 60 * 1000 && now - nativeTokenCache.time < 4 * 60 * 1000) {
        sendKeepalive(nativeTokenCache.token).catch(() => {});
    }
    if (nativeTokenCache.token && now - nativeTokenCache.time < 4 * 60 * 1000) return nativeTokenCache.token;
    try {
        const response = await axios_1.default.post(`${normalizeUrl(url)}/auth/login`, { username, password }, {
            headers: { 'Content-Type': 'application/json', 'User-Agent': getUserAgent() }, timeout: 10000
        });
        if (response.data && response.data.token) {
            nativeTokenCache = { token: response.data.token, time: now };
            return response.data.token;
        }
        return null;
    } catch { return null; }
}

// --- 统一URL处理 ---
function normalizeUrl(url) {
    if (!url.startsWith("http://") && !url.startsWith("https://")) url = `http://${url}`;
    return url.replace(/\/+$/, "");
}


// --- 基础 API ---
async function httpGet(urlPath, params) {
    const { url } = getUserVariables();
    const authParams = getAuthParams();
    const fullUrl = `${normalizeUrl(url)}/rest/${urlPath}`;
    try {
        // const response = await axios_1.default.get(fullUrl, {
        //     params: { ...authParams, ...params },
        //     timeout: 20000,
        //     paramsSerializer: params => qs.stringify(params, { arrayFormat: 'repeat' })
        // });

        const config = {
            method: method,
            url: fullUrl,
            timeout: 20000,
            paramsSerializer: params => qs.stringify(params, { arrayFormat: 'repeat' }),
            headers: { 'User-Agent': getUserAgent() }
        };
        // 合并基础参数和请求参数
        const mergedParams = { ...authParams, ...params };
        // GET 请求参数放在查询字符串，POST 请求参数放在请求体
        if (method === 'get') {
            config.params = mergedParams;
        } else {
            config.data = qs.stringify(mergedParams, { arrayFormat: 'repeat' });
            config.headers = {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': getUserAgent()
            };
        }
        const response = await axios_1.default.request(config);

        if (response.data?.['subsonic-response']?.status === 'failed') {
            const error = response.data['subsonic-response'].error;
            if (error.code === 40) throw new Error(`Navidrome 认证失败: 用户名或密码错误 (代码: 40)`);
            throw new Error(`Navidrome API 错误: ${error.message} (代码: ${error.code})`);
        }
        if (response.status < 200 || response.status >= 300) throw new Error(`Navidrome 服务器请求失败，HTTP 状态码: ${response.status}`);
        return response.data;
    } catch (error) {
        if (error instanceof Error && (error.message.startsWith('Navidrome') || error.message.startsWith('无法'))) throw error;
        else throw new Error(`无法连接到 Navidrome 服务器或请求失败: ${error.message}`);
    }
}

async function httpGetNative(path, params) {
    const { url } = getUserVariables();
    const nativeToken = await getNativeToken();
    if (!nativeToken) throw new Error("无法获取 Navidrome Native API Token，请检查用户名和密码");
    const fullUrl = `${normalizeUrl(url)}/api/${path}`;
    try {
        const response = await axios_1.default.get(fullUrl, {
            params: params,
            headers: {
                'x-nd-authorization': `Bearer ${nativeToken}`,
                'User-Agent': getUserAgent()
            },
            timeout: 20000,
            paramsSerializer: params => qs.stringify(params, { arrayFormat: 'repeat' })
        });
        if (response.status < 200 || response.status >= 300) throw new Error(`Navidrome Native API 请求失败，HTTP 状态码: ${response.status}`);
        return { data: response.data, headers: response.headers };
    } catch (error) {
        throw new Error(`无法连接到 Navidrome Native API 或请求失败: ${error.message}`);
    }
}

function generateCoverArtUrl(coverArtId) {
    if (!coverArtId) return null;
    const { url } = getUserVariables();
    const authParams = getAuthParams();
    const coverUrl = new URL(`${normalizeUrl(url)}/rest/getCoverArt`);
    Object.entries(authParams).forEach(([key, value]) => coverUrl.searchParams.append(key, value));
    coverUrl.searchParams.append('id', String(coverArtId));
    return coverUrl.toString();
}

// --- 格式化函数 ---
function formatMusicItem(navidromeSong) {
    return {
        id: String(navidromeSong.id),
        title: navidromeSong.title || "未知歌曲",
        artist: navidromeSong.artist || "未知艺术家",
        album: navidromeSong.album || "未知专辑",
        artwork: generateCoverArtUrl(navidromeSong.coverArt || navidromeSong.albumId),
        duration: navidromeSong.duration,
        suffix: navidromeSong.suffix,
        _source: 'navidrome'
    };
}
function formatAlbumItem(navidromeAlbum) {
    return {
        id: String(navidromeAlbum.id),
        title: navidromeAlbum.name || navidromeAlbum.title || "未知专辑",
        artist: navidromeAlbum.artist || "未知艺术家",
        artwork: generateCoverArtUrl(navidromeAlbum.coverArt || `al-${navidromeAlbum.id}`),
        description: `歌曲数: ${navidromeAlbum.songCount || '?'}`
    };
}
function formatArtistItem(navidromeArtist) {
    return {
        id: String(navidromeArtist.id),
        name: navidromeArtist.name || "未知艺术家",
        avatar: generateCoverArtUrl(navidromeArtist.coverArt || `ar-${navidromeArtist.id}`),
        platform: '南瓜音乐'
    };
}
function formatSheetItem(navidromePlaylist, username = "Navidrome 用户") {
    return {
        id: String(navidromePlaylist.id),
        title: navidromePlaylist.name || "未知播放列表",
        artist: navidromePlaylist.owner || username,
        artwork: generateCoverArtUrl(navidromePlaylist.coverArt || `pl-${navidromePlaylist.id}`),
        description: `歌曲: ${navidromePlaylist.songCount || '?'}, 时长: ${Math.round((navidromePlaylist.duration || 0) / 60)}分钟`,
        playCount: navidromePlaylist.playCount
    };
}
function formatQQImportItem(qqSong) {
    var _a, _b, _c;
    // const albumid = qqSong.albumid || ((_a = qqSong.album) ?? {}).id;
    const albummid = qqSong.albummid || ((_b = qqSong.album) ?? {}).mid;
    const albumname = qqSong.albumname || ((_c = qqSong.album) ?? {}).title;
    return {
        id: `qq-tmp-${qqSong.id || qqSong.songid}`,
        songmid: qqSong.mid || qqSong.songmid,
        title: qqSong.title || qqSong.songname,
        artist: Array.isArray(qqSong.singer) ? qqSong.singer.map((s)=>s.name).join("/") : "未知艺术家",
        album: albumname,
        artwork: albummid ? `https://y.gtimg.cn/music/photo_new/T002R800x800M000${albummid}.jpg` : undefined,
        duration: qqSong.interval,
        // albumid: albumid,
        albummid: albummid,
        // _source: 'qq-import',
        _qqId: String(qqSong.id || qqSong.songid)
    };
}
function formatNcmMusicItem(ncmSong) {
    const album = ncmSong.al || ncmSong.album;
    const artists = ncmSong.ar || ncmSong.artists;
    return {
        id: `ncm-tmp-${String(ncmSong.id)}`,
        title: ncmSong.name || "未知歌曲",
        artist: (Array.isArray(artists) && artists.length > 0) ? artists.map(a => a.name).join('/') : "未知艺术家",
        album: album?.name || "未知专辑",
        artwork: album?.picUrl,
        duration: ncmSong.dt ? Math.round(ncmSong.dt / 1000) : undefined,
        // _source: 'ncm-import',
        _ncmId: String(ncmSong.id)
    };
}

// --- 搜索与详情 ---
async function searchMusic(query, page, count = pageSize) {
    const offset = (page - 1) * count;
    const data = await httpGet('search3', { query, songCount: count, songOffset: offset, artistCount: 0, albumCount: 0 });
    const songs = data?.['subsonic-response']?.searchResult3?.song ?? [];
    return { isEnd: songs.length < count, data: songs.map(formatMusicItem) };
}
async function searchAlbum(query, page) {
    const offset = (page - 1) * pageSize;
    const data = await httpGet('search3', { query, albumCount: pageSize, albumOffset: offset, artistCount: 0, songCount: 0 });
    const albums = data?.['subsonic-response']?.searchResult3?.album ?? [];
    return { isEnd: albums.length < pageSize, data: albums.map(formatAlbumItem) };
}
async function searchArtist(query, page) {
    const offset = (page - 1) * pageSize;
    const data = await httpGet('search3', { query, artistCount: pageSize, artistOffset: offset, albumCount: 0, songCount: 0 });
    const artists = data?.['subsonic-response']?.searchResult3?.artist ?? [];
    return { isEnd: artists.length < pageSize, data: artists.map(formatArtistItem) };
}
async function searchSheet(query, page, username) {
    const data = await httpGet('getPlaylists', {});
    const playlists = data?.['subsonic-response']?.playlists?.playlist ?? [];
    let filteredPlaylists = playlists;
    if (query && query.trim()) {
        const lowerCaseQuery = query.trim().toLowerCase();
        filteredPlaylists = filteredPlaylists.filter(p => p.name && p.name.toLowerCase().includes(lowerCaseQuery));
    }
    return { isEnd: true, data: filteredPlaylists.map(p => formatSheetItem(p, username)).filter(p => p !== null) };
}
async function getAlbumInfoApi(albumItem, page) {
    if (page > 1) return { isEnd: true, musicList: [] };
    const data = await httpGet('getAlbum', { id: albumItem.id });
    const albumData = data?.['subsonic-response']?.album;
    const songs = albumData?.song ?? [];
    const supplementaryAlbumData = formatAlbumItem(albumData || { id: albumItem.id, title: albumItem.title });
    if (albumData?.artist && albumData?.year) supplementaryAlbumData.description = `${albumData.artist} - ${albumData.year}`;
    else if (albumData?.artist) supplementaryAlbumData.description = albumData.artist;
    return { isEnd: true, musicList: songs.map(formatMusicItem), albumItem: supplementaryAlbumData };
}
async function getMusicSheetInfoApi(sheetItem, page) {
    if (sheetItem.id === ALL_SONGS_TAG.id) return await getAllSongsApi(page);
    if (page > 1) return { isEnd: true, musicList: [] };
    const data = await httpGet('getPlaylist', { id: sheetItem.id });
    const playlistData = data?.['subsonic-response']?.playlist;
    const songs = playlistData?.entry ?? [];
    const supplementarySheetData = formatSheetItem(playlistData || { id: sheetItem.id, name: sheetItem.title });
    if (playlistData?.comment) supplementarySheetData.description = playlistData.comment;
    return { isEnd: true, musicList: songs.map(formatMusicItem), sheetItem: supplementarySheetData };
}
async function getAllSongsApi(page) {
    const offset = (page - 1) * pageSize;
    try {
        const data = await httpGet('search3', { query: '', songCount: pageSize, songOffset: offset, artistCount: 0, albumCount: 0 });
        const songs = data?.['subsonic-response']?.searchResult3?.song ?? [];
        const isEnd = songs.length < pageSize;
        return {
            isEnd: isEnd,
            musicList: songs.map(formatMusicItem),
            sheetItem: page === 1 ? { id: ALL_SONGS_TAG.id, title: ALL_SONGS_TAG.title, description: "服务器上的全部音乐" } : undefined
        };
    } catch(e) {
        return { isEnd: true, musicList: [] };
    }
}

// --- 歌词获取 ---
async function getLyricApi(musicItem) {
    if (!musicItem || !musicItem.title) return null;
    try {
        const params = { title: musicItem.title };
        if (musicItem.artist && !['unknown artist', 'various artists'].includes(musicItem.artist.toLowerCase())) params.artist = musicItem.artist;
        if (musicItem.album && !['unknown album'].includes(musicItem.album.toLowerCase())) params.album = musicItem.album;
        const response = await axios_1.default.get(`${LYRICS_API_BASE_URL}/lyrics`, {
            params, responseType: 'text', timeout: 10000, headers: { 'User-Agent': getUserAgent() }
        });
        if (response.data && typeof response.data === 'string' && response.data.trim()) {
            if (!response.data.toLowerCase().includes('not found') && response.data.length > 10)
                return { rawLrc: he.decode(response.data) };
        }
    } catch {}
    return null;
}

// --- scrobble 上报函数 ---
async function scrobbleApi(musicItem, submission = false) {
    const { url } = getUserVariables();
    const authParams = getAuthParams();
    const scrobbleUrl = `${normalizeUrl(url)}/rest/scrobble`;
    try {
        await axios_1.default.get(scrobbleUrl, {
            params: {
                ...authParams,
                id: String(musicItem.id),
                submission: submission ? "true" : "false"
            },
            timeout: 10000,
            headers: { 'User-Agent': getUserAgent() }
        });
        return true;
    } catch (e) {
        return false;
    }
}

// --- 全局变量，记录上一次播放的歌曲 ---
let lastPlayedMusicItem = null;

// --- 歌曲ID失效时自动搜索替换 ---
async function tryAutoFixMusicId(musicItem) {
    // 只处理本地歌单（可根据你的业务逻辑调整判断条件）
    if (!musicItem || !musicItem.title || !musicItem.artist) return null;
    // 搜索同名歌曲
    const { data } = await searchMusic(musicItem.title, 1, 10);
    // 简单匹配：标题、歌手、专辑、时长等
    let bestMatch = data.find(item =>
        item.title === musicItem.title &&
        item.artist === musicItem.artist &&
        (!musicItem.album || item.album === musicItem.album) &&
        (!musicItem.duration || Math.abs(item.duration - musicItem.duration) < 5)
    );
    // 没有完全匹配就用第一个
    if (!bestMatch && data.length > 0) bestMatch = data[0];
    if (bestMatch) {
        // 替换ID
        musicItem.id = bestMatch.id;
        // 你可以在这里同步更新本地歌单存储（如有持久化）
        return musicItem;
    }
    return null;
}
// --- 播放流获取函数 ---
async function getMediaSourceApi(musicItem, quality) {
    const { url } = getUserVariables();
    const authParams = getAuthParams();
    const streamUrl = new URL(`${normalizeUrl(url)}/rest/stream`);
    Object.entries(authParams).forEach(([key, value]) => streamUrl.searchParams.append(key, value));
    streamUrl.searchParams.append('id', String(musicItem.id));

    try {
        const response = await axios_1.default.get(streamUrl.toString(), {
            responseType: 'arraybuffer',
            timeout: 15000,
            validateStatus: () => true,
            headers: { 'User-Agent': getUserAgent() }
        });
        const contentType = response.headers['content-type'] || '';
        if (contentType.startsWith('audio/')) {
            // 有效音频流
            if (lastPlayedMusicItem && lastPlayedMusicItem.id !== musicItem.id) {
                scrobbleApi(lastPlayedMusicItem, true).catch(() => {});
            }
            lastPlayedMusicItem = musicItem;
            return { url: streamUrl.toString() };
        } else if (contentType.includes('application/json') || contentType.includes('text/')) {
            // 可能是错误信息
            let text = '';
            try {
                text = Buffer.from(response.data).toString('utf8');
                const json = JSON.parse(text);
                const status = json?.['subsonic-response']?.status;
                const errorCode = json?.['subsonic-response']?.error?.code;
                if (status === 'failed' && errorCode === 70) {
                    // data not found，尝试自动修复
                    const fixed = await tryAutoFixMusicId(musicItem);
                    if (fixed) {
                        await new Promise(r => setTimeout(r, 100));
                        return await getMediaSourceApi(fixed, quality);
                    }
                    return null;
                }
            } catch {}
            return null;
        }
        return null;
    } catch (e) {
        return null;
    }
}

async function getMusicInfoApi(musicItem) {
    if (musicItem._source === 'navidrome_qq_artwork' || musicItem._source === 'navidrome_ncm_artwork') {
        if (musicItem.artwork) return { artwork: musicItem.artwork };
    }
    if (musicItem.artwork && typeof musicItem.artwork === 'string' && (musicItem.artwork.startsWith('http') || musicItem.artwork.startsWith('mf-'))) {
        return { artwork: musicItem.artwork };
    }
    try {
        const params = new URLSearchParams();
        params.append('title', musicItem.title || '');
        if (musicItem.artist && !['unknown artist', 'various artists'].includes(musicItem.artist.toLowerCase())) params.append('artist', musicItem.artist);
        if (musicItem.album && !['unknown album'].includes(musicItem.album.toLowerCase())) params.append('album', musicItem.album);
        const coverApiUrl = `${LYRICS_API_BASE_URL}/cover?${params.toString()}`;
        return { artwork: coverApiUrl };
    } catch {}
    if (musicItem.id && musicItem._source === 'navidrome') {
        const navidromeCover = generateCoverArtUrl(musicItem.id);
        if (navidromeCover) return { artwork: navidromeCover };
    }
    return null;
}


// --- 推荐/排行榜 ---
async function getRecommendSheetTagsApi() {
    return { pinned: [ ALL_SONGS_TAG, ALL_PLAYLISTS_TAG ], data: [] };
}
async function getRecommendSheetsByTagApi(tag, page, username) {
    const nativeToken = await getNativeToken();
    if (tag.id === ALL_PLAYLISTS_TAG.id && nativeToken) {
        sendKeepalive(nativeToken).catch(() => {});
    }
    if (tag.id === ALL_PLAYLISTS_TAG.id) {
        if (page > 1) return { isEnd: true, data: [] };
        const data = await httpGet('getPlaylists', {});
        const playlists = data?.['subsonic-response']?.playlists?.playlist ?? [];
        return { isEnd: true, data: playlists.map(p => formatSheetItem(p, username)).filter(p => p !== null) };
    } else if (tag.id === ALL_SONGS_TAG.id) {
        if (page > 1) return { isEnd: true, data: [] };
        const fakeSheet = { id: ALL_SONGS_TAG.id, title: ALL_SONGS_TAG.title, artist: username || "Navidrome", artwork: null, description: "浏览服务器上的所有歌曲" };
        return { isEnd: true, data: [fakeSheet] };
    } else {
        return { isEnd: true, data: [] };
    }
}
// --- Top榜单功能 ---
async function getTopListsApi() {
    const lists = [
        { id: 'navidrome_toplist_starred', title: '我的收藏' },
        { id: 'navidrome_toplist_random', title: '随机播放' },
        { id: 'navidrome_toplist_newest', title: '最新添加' },
        { id: 'navidrome_toplist_frequent', title: '播放最多' },
        { id: 'navidrome_toplist_recent', title: '最近播放' }
    ];
    return [{ title: "Navidrome 排行榜", data: lists }];
}

async function getTopListDetailApi(topListItem, page) {
    try {
        const start = (page - 1) * pageSize;
        const end = page * pageSize;
        if (topListItem.id === 'navidrome_toplist_starred') {
            if (page > 1) {
                return { isEnd: true, musicList: [] };
            }
            const data = await httpGet('getStarred', {});
            const songs = data?.['subsonic-response']?.starred?.song ?? [];
            return { isEnd: true, musicList: songs.map(formatMusicItem) };

        } else if (topListItem.id === 'navidrome_toplist_random') {
             if (page > 1) {
                  const data = await httpGet('getRandomSongs', { size: pageSize });
                  const songs = data?.['subsonic-response']?.randomSongs?.song ?? [];
                  return { isEnd: true, musicList: songs.map(formatMusicItem) };
             }
            const data = await httpGet('getRandomSongs', { size: pageSize });
            const songs = data?.['subsonic-response']?.randomSongs?.song ?? [];
            return { isEnd: true, musicList: songs.map(formatMusicItem) };

        } else {
            let sortField = '';
            let sortOrder = 'DESC';
            switch (topListItem.id) {
                case 'navidrome_toplist_newest': sortField = 'createdAt'; break;
                case 'navidrome_toplist_frequent': sortField = 'play_count'; break;
                case 'navidrome_toplist_recent': sortField = 'play_date'; break;
                default:
                    return { isEnd: true, musicList: [] };
            }

            const response = await httpGetNative('song', {
                _sort: sortField,
                _order: sortOrder,
                _start: start,
                _end: end
            });
            const songs = response.data ?? [];

            const isEnd = songs.length < pageSize;

            return { isEnd, musicList: songs.map(formatMusicItem) };
        }
    } catch (e) {
        return { isEnd: true, musicList: [] };
    }
}

async function sendKeepalive(nativeToken) {
    const { url } = getUserVariables();
    if (!url || !nativeToken) return false;
    const keepaliveUrl = `${normalizeUrl(url)}/api/keepalive/keepalive`;
    try {
        const response = await axios_1.default.get(keepaliveUrl, {
            headers: {
                'x-nd-authorization': `Bearer ${nativeToken}`,
                'User-Agent': getUserAgent()
            },
            timeout: 10000
        });
        return response.status >= 200 && response.status < 300;
    } catch (error) { return false; }
}

// --- 歌单导入（QQ/网易云） ---
// QQ
async function getQQPlaylistDetails(id) {
    try {
        const result = (await axios_1.default({
            url: `http://i.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&utf8=1&disstid=${id}&loginUin=0`,
            headers: { Referer: "https://y.qq.com/n/yqq/playlist", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36", Cookie: "uin=" },
            method: "get",
            timeout: 15000
        })).data;
        const jsonString = result.replace(/callback\(|MusicJsonCallback\(|jsonCallback\(|\)$/g, "");
        const res = JSON.parse(jsonString);
        if (!res.cdlist || res.cdlist.length === 0) throw new Error("QQ 音乐 API 未返回有效的歌单列表。");
        const playlistData = res.cdlist[0];
        const name = he.decode(playlistData.dissname || `QQ 音乐歌单 ${id}`);
        const cover = playlistData.logo;
        const songs = (playlistData.songlist || []).map(formatQQImportItem);
        return { name, cover, songs };
    } catch (e) {
        throw new Error(`获取 QQ 音乐歌单信息失败 (ID: ${id}): ${e.message}`);
    }
}
async function findAndMergeQQTrackOnNavidrome(qqTrack) {
    const query = `${qqTrack.title} ${qqTrack.artist}`;
    try {
        const searchResult = await searchMusic(query, 1, QQ_MATCH_RESULT_COUNT);
        if (!searchResult.data || searchResult.data.length === 0) return null;
        let bestMatch = null, bestMatchScore = -1;
        for (const naviTrack of searchResult.data) {
            let currentScore = 0;
            const titleMatch = naviTrack.title?.toLowerCase() === qqTrack.title?.toLowerCase();
            const artistMatch = naviTrack.artist?.toLowerCase() === qqTrack.artist?.toLowerCase();
            let durationMatch = false;
            if (typeof naviTrack.duration === 'number' && typeof qqTrack.duration === 'number') durationMatch = (Math.abs(naviTrack.duration - qqTrack.duration) <= DURATION_TOLERANCE_SECONDS);
            if (titleMatch) currentScore += 10;
            if (artistMatch) currentScore += 5;
            if (durationMatch) currentScore += 8;
            if (titleMatch && artistMatch && durationMatch) { bestMatch = naviTrack; bestMatchScore = currentScore; break; }
            if (currentScore > bestMatchScore) { bestMatch = naviTrack; bestMatchScore = currentScore; }
        }
        if (bestMatch && bestMatchScore >= 10) {
            return {
                id: bestMatch.id,
                title: bestMatch.title,
                artist: bestMatch.artist,
                album: bestMatch.album,
                artwork: qqTrack.artwork,
                duration: bestMatch.duration,
                suffix: bestMatch.suffix,
                _source: 'navidrome_qq_artwork',
                // songmid: qqTrack.songmid,
                // _qqId: qqTrack._qqId
            };
        } else return null;
    } catch (e) { return null; }
}
async function processQQPlaylistImport(id) {
    const { name: qqPlaylistName, songs: qqTracks } = await getQQPlaylistDetails(id);
    if (!qqTracks || qqTracks.length === 0) return { playlistName: qqPlaylistName || `QQ 歌单 ${id}`, matchedTracks: [] };
    const matchedNavidromeTracks = [];
    const searchPromises = [];
    for (let i = 0; i < qqTracks.length; i++) {
        const qqTrack = qqTracks[i];
        const searchPromise = findAndMergeQQTrackOnNavidrome(qqTrack).catch(()=>null);
        searchPromises.push(searchPromise);
        if (searchPromises.length >= QQ_IMPORT_CONCURRENCY || i === qqTracks.length - 1) {
            const results = await Promise.all(searchPromises);
            results.forEach(track => { if (track) matchedNavidromeTracks.push(track); });
            searchPromises.length = 0;
        }
    }
    return { playlistName: qqPlaylistName, matchedTracks: matchedNavidromeTracks };
}
// 网易云
async function getNcmTrackDetails(trackIds) {
    if (!trackIds || trackIds.length === 0) return [];
    const ncmHeaders = { Referer: "https://music.163.com/", Origin: "https://music.163.com/", "User-Agent": "Mozilla/5.0" };
    const apiUrl = `https://music.163.com/api/song/detail/?ids=[${trackIds.join(",")}]`;
    try {
        const response = await axios_1.default.get(apiUrl, { headers: ncmHeaders, timeout: 15000 });
        if (response.data?.songs?.length > 0) return response.data.songs.map(formatNcmMusicItem);
        return [];
    } catch (e) { return []; }
}
async function getNcmPlaylistDetails(id) {
    const ncmHeaders = { Referer: "https://music.163.com/", Origin: "https://music.163.com/", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36" };
    const apiUrl = `https://music.163.com/api/v3/playlist/detail?id=${id}&n=100000`;
    try {
        const response = await axios_1.default.get(apiUrl, { headers: ncmHeaders, timeout: 15000 });
        const playlistData = response.data?.playlist;
        if (playlistData && playlistData.trackIds) {
            const trackIds = playlistData.trackIds.map((_) => _.id);
            const name = he.decode(playlistData.name || `网易云歌单 ${id}`);
            const cover = playlistData.coverImgUrl;
            return { trackIds, name, cover };
        } else throw new Error("无法获取网易云歌单详情。");
    } catch (e) { throw new Error(`获取网易云歌单信息失败: ${e.message}`); }
}
async function findAndMergeNcmTrackOnNavidrome(ncmTrack) {
    const query = `${ncmTrack.title} ${ncmTrack.artist}`;
    try {
        const searchResult = await searchMusic(query, 1, NCM_MATCH_RESULT_COUNT);
        if (!searchResult.data || searchResult.data.length === 0) return null;
        let bestMatch = null, bestMatchScore = -1;
        for (const naviTrack of searchResult.data) {
            let currentScore = 0;
            let titleMatch = (naviTrack.title.toLowerCase() === ncmTrack.title.toLowerCase());
            let artistMatch = (naviTrack.artist.toLowerCase() === ncmTrack.artist.toLowerCase());
            let durationMatch = false;
            if (typeof naviTrack.duration === 'number' && typeof ncmTrack.duration === 'number') durationMatch = (Math.abs(naviTrack.duration - ncmTrack.duration) <= DURATION_TOLERANCE_SECONDS);
            if (titleMatch) currentScore += 10;
            if (artistMatch) currentScore += 5;
            if (durationMatch) currentScore += 8;
            if (titleMatch && artistMatch && durationMatch) { bestMatch = naviTrack; break; }
            if (currentScore > bestMatchScore) { bestMatch = naviTrack; bestMatchScore = currentScore; }
        }
        if (bestMatch && bestMatchScore >= 10) {
            return {
                id: bestMatch.id,
                title: bestMatch.title,
                artist: bestMatch.artist,
                album: bestMatch.album,
                artwork: ncmTrack.artwork,
                duration: bestMatch.duration,
                suffix: bestMatch.suffix,
                _source: 'navidrome_ncm_artwork'
            };
        } else return null;
    } catch (e) { return null; }
}
async function processNcmPlaylistImport(id) {
    const ncmDetails = await getNcmPlaylistDetails(id);
    if (!ncmDetails || ncmDetails.trackIds.length === 0) return { playlistName: `网易云歌单 ${id}`, matchedTracks: [] };
    const { trackIds, name: ncmPlaylistName } = ncmDetails;
    let ncmTracks = [];
    const batchSizeNcm = 200;
    for (let i = 0; i < trackIds.length; i += batchSizeNcm) {
        const batchIds = trackIds.slice(i, i + batchSizeNcm);
        const batchResult = await getNcmTrackDetails(batchIds);
        ncmTracks = ncmTracks.concat(batchResult);
    }
    const matchedNavidromeTracks = [];
    const searchPromises = [];
    for (const ncmTrack of ncmTracks) {
        const searchPromise = findAndMergeNcmTrackOnNavidrome(ncmTrack).catch(()=>null);
        searchPromises.push(searchPromise);
        if (searchPromises.length >= NCM_IMPORT_CONCURRENCY) {
            const results = await Promise.all(searchPromises);
            results.forEach(track => { if (track) matchedNavidromeTracks.push(track); });
            searchPromises.length = 0;
        }
    }
    if (searchPromises.length > 0) {
        const results = await Promise.all(searchPromises);
        results.forEach(track => { if (track) matchedNavidromeTracks.push(track); });
    }
    return { playlistName: ncmPlaylistName, matchedTracks: matchedNavidromeTracks };
}

// --- 歌单创建/添加 ---
async function createNavidromePlaylistApi(name) {
    try {
        const responseData = await httpGet('createPlaylist', { name: name });
        if (responseData?.['subsonic-response']?.playlist) return responseData['subsonic-response'].playlist.id;
        else if (responseData?.['subsonic-response']?.status === 'ok') {
            const playlistsData = await httpGet('getPlaylists', {});
            const playlists = playlistsData?.['subsonic-response']?.playlists?.playlist ?? [];
            const createdPlaylist = playlists.find(p => p.name === name);
            if (createdPlaylist) return createdPlaylist.id;
            else return null;
        } else throw new Error("创建歌单 API 未返回有效信息。");
    } catch (error) { return null; }
}
async function addSongsToNavidromePlaylistApi(playlistId, songIds) {
    if (!playlistId || !songIds || songIds.length === 0) return false;
    try {
        // await httpGet('updatePlaylist', { playlistId: playlistId, songIdToAdd: songIds });
        await httpGet('updatePlaylist', { playlistId: playlistId, songIdToAdd: songIds }, 'post');
        return true;
    } catch (error) { return false; }
}

// --- 插件导出对象 ---
module.exports = {
    platform: "musicfree南瓜音乐",
    version: "2.6.1",
    author: 'v',
    srcUrl: "https://raw.githubusercontent.com/rceayo/hub/refs/heads/main/misc/nangua.js",
    cacheControl: "no-cache",
    userVariables: [
        { key: "url", name: "服务器地址 (URL)" },
        { key: "username", name: "用户名" },
        { key: "password", name: "密码" }
    ],
    supportedSearchType: ["music", "album", "sheet", "artist"],
    hints: {
        importMusicSheet: [
            "请输入 QQ 音乐或网易云歌单分享链接或纯数字ID。",
            "导入时会尝试在您的 Navidrome 上查找并匹配歌曲。",
            "如果匹配成功，将在 Navidrome 上创建或更新同名歌单。",
            "【重要】如果 Navidrome 上已存在同名歌单，将会被删除并替换为本次导入的内容！",
            "【重要】导入速度取决于歌单大小和服务器响应，可能需几分钟。",
            "【重要】只有成功匹配的歌曲才会被导入 Navidrome 歌单。"
        ],
        importMusicItem: []
    },
    async search(query, page, type) {
        const userVariables = env?.getUserVariables() ?? {};
        try {
            if (type === "music") return await searchMusic(query, page);
            if (type === "album") return await searchAlbum(query, page);
            if (type === "sheet") return await searchSheet(query, page, userVariables.username);
            if (type === "artist") return await searchArtist(query, page);
            return { isEnd: true, data: [] };
        } catch (e) { return { isEnd: true, data: [] }; }
    },
    async getAlbumInfo(albumItem, page) {
        try { return await getAlbumInfoApi(albumItem, page); }
        catch (e) { return { isEnd: true, musicList: [] }; }
    },
    async getMusicSheetInfo(sheetItem, page) {
        try { return await getMusicSheetInfoApi(sheetItem, page); }
        catch (e) { return { isEnd: true, musicList: [] }; }
    },
    async getArtistWorks(artistItem, page, type) {
        try {
            if (type === 'music') {
                const result = await searchMusic(artistItem.name, page);
                return { isEnd: result.isEnd, data: result.data };
            }
            if (type === 'album') {
                if (page > 1) return { isEnd: true, data: [] };
                const data = await httpGet('getArtist', { id: artistItem.id });
                const albums = data?.['subsonic-response']?.artist?.album ?? [];
                return { isEnd: true, data: albums.map(formatAlbumItem) };
            }
            return { isEnd: true, data: [] };
        } catch (e) { return { isEnd: true, data: [] }; }
    },
    async getMediaSource(musicItem, quality) {
        try { return await getMediaSourceApi(musicItem, quality); }
        catch (e) { return null; }
    },
    async getLyric(musicItem) {
        try { return await getLyricApi(musicItem); }
        catch (e) { return null; }
    },
    async getRecommendSheetTags() {
        try { return await getRecommendSheetTagsApi(); }
        catch (e) { return { pinned: [], data: [] }; }
    },
    async getRecommendSheetsByTag(tag, page) {
        const userVariables = env?.getUserVariables() ?? {};
        try { return await getRecommendSheetsByTagApi(tag, page, userVariables.username); }
        catch (e) { return { isEnd: true, data: [] }; }
    },
    async getMusicInfo(musicItem) {
        try { return await getMusicInfoApi(musicItem); }
        catch (e) { return null; }
    },
    // 支持 QQ/网易云歌单导入
    async importMusicSheet(urlLike) {
        const nativeToken = await getNativeToken();
        if (nativeToken) {
            sendKeepalive(nativeToken).catch(() => {});
        }
        // QQ 歌单正则
        const qqRegexList = [
            /https?:\/\/i\.y\.qq\.com\/n2\/m\/share\/details\/taoge\.html\?.*id=([0-9]+)/,
            /https?:\/\/y\.qq\.com\/n\/ryqq\/playlist\/([0-9]+)/,
            /^(\d+)$/
        ];
        // 先尝试 QQ 歌单导入
        for (const regex of qqRegexList) {
            const matchResult = urlLike.match(regex);
            if (matchResult && matchResult[1]) {
                try {
                    const { playlistName: qqPlaylistName, matchedTracks } = await processQQPlaylistImport(matchResult[1]);
                    if (matchedTracks.length > 0 && qqPlaylistName) {
                        let existingPlaylistId = null;
                        try {
                            const playlistsData = await httpGet('getPlaylists', {});
                            const playlists = playlistsData?.['subsonic-response']?.playlists?.playlist ?? [];
                            const existingPlaylist = playlists.find(p => p.name === qqPlaylistName);
                            if (existingPlaylist) existingPlaylistId = existingPlaylist.id;
                        } catch (e) {}
                        if (existingPlaylistId) {
                            try { await httpGet('deletePlaylist', { id: existingPlaylistId }); } catch (e) {}
                        }
                        const newNavidromePlaylistId = await createNavidromePlaylistApi(qqPlaylistName);
                        if (newNavidromePlaylistId) {
                            const navidromeSongIdsToAdd = deduplicateTracks(matchedTracks).map(track => track.id);
                            await addSongsToNavidromePlaylistApi(newNavidromePlaylistId, navidromeSongIdsToAdd);
                        }
                    }
                    const localPlaylistTracks = deduplicateTracks(matchedTracks).filter(track => track.suffix?.toLowerCase() !== 'm4a');
                    return localPlaylistTracks;
                } catch (e) {
                    // 如果是纯数字ID，且QQ导入失败，继续尝试网易云
                    if (regex.toString() === '/^(\\d+)$/') {
                        // 继续往下走，尝试网易云
                    } else {
                        throw new Error(`导入 QQ 歌单失败: ${e.message}`);
                    }
                }
            }
        }
        // 网易云歌单正则
        const ncmPlaylistRegex = /(?:https:\/\/y\.music\.163\.com\/m\/playlist\?id=([0-9]+))|(?:https?:\/\/music\.163\.com\/playlist\/([0-9]+)\/.*)|(?:https?:\/\/music\.163\.com(?:\/m)?\/(?:#\/)?playlist\?.*?id=(\d+)(?:&|$))|(?:^\s*(\d+)\s*$)/;
        const matchResult = urlLike.match(ncmPlaylistRegex);
        if (matchResult) {
            const id = matchResult[1] || matchResult[2] || matchResult[3] || matchResult[4];
            if (!id) throw new Error("无法从输入中提取有效的网易云歌单 ID。");
            try {
                const { playlistName: ncmPlaylistName, matchedTracks } = await processNcmPlaylistImport(id);
                if (matchedTracks.length > 0) {
                    let existingPlaylistId = null;
                    try {
                        const playlistsData = await httpGet('getPlaylists', {});
                        const playlists = playlistsData?.['subsonic-response']?.playlists?.playlist ?? [];
                        const existingPlaylist = playlists.find(p => p.name === ncmPlaylistName);
                        if (existingPlaylist) existingPlaylistId = existingPlaylist.id;
                    } catch (e) {}
                    if (existingPlaylistId) {
                        try { await httpGet('deletePlaylist', { id: existingPlaylistId }); } catch (e) {}
                    }
                    const newNavidromePlaylistId = await createNavidromePlaylistApi(ncmPlaylistName);
                    if (newNavidromePlaylistId) {
                        const navidromeSongIdsToAdd = deduplicateTracks(matchedTracks).map(track => track.id);
                        await addSongsToNavidromePlaylistApi(newNavidromePlaylistId, navidromeSongIdsToAdd);
                    }
                }
                const localPlaylistTracks = deduplicateTracks(matchedTracks).filter(track => track.suffix?.toLowerCase() !== 'm4a');
                return localPlaylistTracks;
            } catch (e) { throw new Error(`导入网易云歌单失败: ${e.message}`); }
        }
        throw new Error("无法识别的 QQ 音乐或网易云歌单链接或 ID 格式。");
    },
    async getTopLists() {
        try { return await getTopListsApi(); }
        catch (e) { return []; }
    },
    async getTopListDetail(topListItem, page) {
        try { return await getTopListDetailApi(topListItem, page); }
        catch (e) { return { isEnd: true, musicList: [] }; }
    }
};