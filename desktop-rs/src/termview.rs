//! 真终端页（C-1）：vte 解析（VT/ANSI）+ 自写屏幕缓冲（行列 Cell 网格 +
//! 滚动回看 + 光标）+ 输入批量缓冲 + resize 防抖。渲染在 app.rs 侧绘制。

use std::collections::VecDeque;
use std::time::Instant;

use vte::{Parser, Perform};

// ---------------------------------------------------------------------------
// 屏幕缓冲
// ---------------------------------------------------------------------------

/// 前景/背景色（ANSI 16 色索引、256 色索引或 RGB）
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Color {
    Default,
    Ansi(u8),
    Rgb(u8, u8, u8),
}

impl Default for Color {
    fn default() -> Self {
        Color::Default
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cell {
    pub ch: char,
    pub fg: Color,
    pub bg: Color,
    pub bold: bool,
    pub underline: bool,
    pub reversed: bool,
}

impl Default for Cell {
    fn default() -> Self {
        Cell { ch: ' ', fg: Color::Default, bg: Color::Default, bold: false, underline: false, reversed: false }
    }
}

/// 样式状态（SGR 累积）
#[derive(Debug, Clone, Copy, Default)]
struct Style {
    fg: Color,
    bg: Color,
    bold: bool,
    underline: bool,
    reversed: bool,
}

/// 滚动回看上限（行数）
const SCROLLBACK_MAX: usize = 5000;

/// 屏幕缓冲：可视网格 + 滚动回看
pub struct TermScreen {
    cols: usize,
    rows: usize,
    /// 可视区（rows 行）
    grid: Vec<Vec<Cell>>,
    /// 滚动回看（先进先出，上限 SCROLLBACK_MAX）
    scrollback: VecDeque<Vec<Cell>>,
    cursor_x: usize,
    cursor_y: usize,
    style: Style,
    cursor_visible: bool,
    /// DECSC（\x1b7）保存的光标位置——DECRC（\x1b8）恢复。
    /// conhost 启动清屏用 \x1b7 保存光标 → 逐行清屏 → \x1b8 恢复；
    /// 不实现则光标停在清屏结束行 → 后续提示符/输出全部错位
    /// （实测：cmd 提示符写到视口外行 38，输入回显"缩进 20"）
    saved_cursor: Option<(usize, usize)>,
}

impl TermScreen {
    pub fn new(cols: usize, rows: usize) -> Self {
        let mut s = Self {
            cols,
            rows,
            grid: Vec::new(),
            scrollback: VecDeque::new(),
            cursor_x: 0,
            cursor_y: 0,
            style: Style::default(),
            cursor_visible: true,
            saved_cursor: None,
        };
        s.grid = vec![vec![Cell::default(); cols]; rows];
        s
    }

    pub fn resize(&mut self, cols: usize, rows: usize) {
        if cols == self.cols && rows == self.rows {
            return;
        }
        // 简化：重建网格（保持光标位置尽量在界内）
        let mut new_grid = vec![vec![Cell::default(); cols]; rows];
        for (y, row) in self.grid.iter().enumerate() {
            if y >= rows {
                break;
            }
            for (x, cell) in row.iter().enumerate() {
                if x < cols {
                    new_grid[y][x] = *cell;
                }
            }
        }
        self.grid = new_grid;
        self.cols = cols;
        self.rows = rows;
        self.cursor_x = self.cursor_x.min(cols - 1);
        self.cursor_y = self.cursor_y.min(rows - 1);
    }

    /// 可视区某行文本（渲染用）
    pub fn line(&self, y: usize) -> &[Cell] {
        &self.grid[y]
    }

    pub fn cols(&self) -> usize {
        self.cols
    }
    pub fn rows(&self) -> usize {
        self.rows
    }
    pub fn cursor(&self) -> (usize, usize) {
        (self.cursor_x, self.cursor_y)
    }
    pub fn cursor_visible(&self) -> bool {
        self.cursor_visible
    }
    // -- 内部操作 ----------------------------------------------------------

    fn scroll_up(&mut self) {
        let top = self.grid.remove(0);
        self.scrollback.push_back(top);
        if self.scrollback.len() > SCROLLBACK_MAX {
            self.scrollback.pop_front();
        }
        self.grid.push(vec![Cell::default(); self.cols]);
        // 注意：调用方（put/newline）已把光标 clamp 到 rows-1 再调本函数——
        // 这里**不能**再减 1（off-by-one 丢行：光标落倒数第二行，滚动时
        // 每隔一行丢一行、末行不贴底——审查模拟验证，2026-08-11）
    }

    fn put(&mut self, ch: char) {
        if ch == '\u{0}' {
            return;
        }
        let cell = Cell {
            ch,
            fg: self.style.fg,
            bg: self.style.bg,
            bold: self.style.bold,
            underline: self.style.underline,
            reversed: self.style.reversed,
        };
        let x = self.cursor_x;
        let y = self.cursor_y;
        if x < self.cols && y < self.rows {
            self.grid[y][x] = cell;
        }
        self.cursor_x += 1;
        if self.cursor_x >= self.cols {
            self.cursor_x = 0;
            self.cursor_y += 1;
            if self.cursor_y >= self.rows {
                self.cursor_y = self.rows - 1;
                self.scroll_up();
            }
        }
    }

    fn newline(&mut self) {
        self.cursor_x = 0;
        self.cursor_y += 1;
        if self.cursor_y >= self.rows {
            self.cursor_y = self.rows - 1;
            self.scroll_up();
        }
    }

    fn erase_line(&mut self, mode: usize) {
        let clear = vec![Cell::default(); self.cols];
        let y = self.cursor_y;
        match mode {
            0 => {
                // 光标后（含光标）
                for x in self.cursor_x..self.cols {
                    self.grid[y][x] = Cell::default();
                }
            }
            1 => {
                // 光标前
                for x in 0..=self.cursor_x.min(self.cols - 1) {
                    self.grid[y][x] = Cell::default();
                }
            }
            _ => {
                self.grid[y] = clear;
            }
        }
    }

    /// 全清（重连用）：清空可视区 + 滚动回看 + 光标归位
    pub fn erase_screen_all(&mut self) {
        for y in 0..self.rows {
            self.grid[y] = vec![Cell::default(); self.cols];
        }
        self.scrollback.clear();
        self.cursor_x = 0;
        self.cursor_y = 0;
    }

    fn erase_screen(&mut self, mode: usize) {
        match mode {
            0 => {
                // 光标后
                for x in self.cursor_x..self.cols {
                    self.grid[self.cursor_y][x] = Cell::default();
                }
                for y in (self.cursor_y + 1)..self.rows {
                    self.grid[y] = vec![Cell::default(); self.cols];
                }
            }
            1 => {
                // 光标前
                for x in 0..=self.cursor_x.min(self.cols - 1) {
                    self.grid[self.cursor_y][x] = Cell::default();
                }
                for y in 0..self.cursor_y {
                    self.grid[y] = vec![Cell::default(); self.cols];
                }
            }
            2 | 3 => {
                // 全清（3 还清滚动回看）
                for y in 0..self.rows {
                    self.grid[y] = vec![Cell::default(); self.cols];
                }
                if mode == 3 {
                    self.scrollback.clear();
                }
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// vte 处理器：把转义流映射到屏幕操作
// ---------------------------------------------------------------------------

pub struct TermScreenHandler<'a>(pub &'a mut TermScreen);

impl Perform for TermScreenHandler<'_> {
    fn print(&mut self, ch: char) {
        self.0.put(ch);
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            b'\r' => self.0.cursor_x = 0,
            b'\n' | 0x0b | 0x0c => self.0.newline(),
            0x08 => {
                if self.0.cursor_x > 0 {
                    self.0.cursor_x -= 1;
                }
            }
            b'\t' => {
                // 跳到下一 tab stop（8 列）
                self.0.cursor_x = (self.0.cursor_x / 8 + 1) * 8;
                if self.0.cursor_x >= self.0.cols {
                    self.0.cursor_x = 0;
                    self.0.cursor_y += 1;
                    if self.0.cursor_y >= self.0.rows {
                        self.0.cursor_y = self.0.rows - 1;
                        self.0.scroll_up();
                    }
                }
            }
            _ => {}
        }
    }

    fn csi_dispatch(&mut self, params: &vte::Params, intermediates: &[u8], ignore: bool, action: char) {
        if ignore {
            return;
        }
        // vte 0.15：Params 按组（&[u16]），平坦化为 i64 序列
        let params: Vec<i64> = params.iter().flat_map(|g| g.iter()).map(|&v| v as i64).collect();
        let p = |i: usize| params.get(i).copied().unwrap_or(0) as usize;
        let p1 = |i: usize| params.get(i).copied().unwrap_or(1) as usize;
        let s: &mut TermScreen = self.0;
        match action {
            // 光标移动
            'A' => s.cursor_y = s.cursor_y.saturating_sub(p1(0)),
            'B' => s.cursor_y = (s.cursor_y + p1(0)).min(s.rows - 1),
            'C' => s.cursor_x = (s.cursor_x + p1(0)).min(s.cols - 1),
            'D' => s.cursor_x = s.cursor_x.saturating_sub(p1(0)),
            'E' => {
                s.cursor_x = 0;
                s.cursor_y = (s.cursor_y + p1(0)).min(s.rows - 1);
            }
            'F' => {
                s.cursor_x = 0;
                s.cursor_y = s.cursor_y.saturating_sub(p1(0));
            }
            'G' | '`' => s.cursor_x = (p1(0) - 1).min(s.cols - 1),
            'H' | 'f' => {
                let row = p1(0).saturating_sub(1).min(s.rows - 1);
                let col = p1(1).saturating_sub(1).min(s.cols - 1);
                s.cursor_x = col;
                s.cursor_y = row;
            }
            'd' => s.cursor_y = p1(0).saturating_sub(1).min(s.rows - 1),
            // 清屏/清行
            'J' => s.erase_screen(p(0)),
            'K' => s.erase_line(p(0)),
            // SGR 样式
            'm' => {
                if params.is_empty() {
                    s.style = Style::default();
                }
                let mut i = 0;
                while i < params.len() {
                    let code = params[i];
                    match code {
                        0 => s.style = Style::default(),
                        1 => s.style.bold = true,
                        4 => s.style.underline = true,
                        7 => s.style.reversed = true,
                        22 => s.style.bold = false,
                        24 => s.style.underline = false,
                        27 => s.style.reversed = false,
                        30..=37 => s.style.fg = Color::Ansi((code - 30) as u8),
                        40..=47 => s.style.bg = Color::Ansi((code - 40) as u8),
                        90..=97 => s.style.fg = Color::Ansi((code - 90 + 8) as u8),
                        100..=107 => s.style.bg = Color::Ansi((code - 100 + 8) as u8),
                        39 => s.style.fg = Color::Default,
                        49 => s.style.bg = Color::Default,
                        // 256 色：38;5;n / 48;5;n
                        38 | 48 if params.get(i + 1) == Some(&5) && params.len() > i + 2 => {
                            let idx = params[i + 2] as u8;
                            if code == 38 {
                                s.style.fg = Color::Ansi(idx);
                            } else {
                                s.style.bg = Color::Ansi(idx);
                            }
                            i += 2;
                        }
                        // truecolor：38;2;r;g;b / 48;2;r;g;b
                        38 | 48 if params.get(i + 1) == Some(&2) && params.len() > i + 4 => {
                            let rgb = (params[i + 2] as u8, params[i + 3] as u8, params[i + 4] as u8);
                            if code == 38 {
                                s.style.fg = Color::Rgb(rgb.0, rgb.1, rgb.2);
                            } else {
                                s.style.bg = Color::Rgb(rgb.0, rgb.1, rgb.2);
                            }
                            i += 4;
                        }
                        _ => {}
                    }
                    i += 1;
                }
            }
            // 光标可见性
            'h' | 'l' if !intermediates.is_empty() && intermediates[0] == b'?' && p(0) == 25 => {
                s.cursor_visible = action == 'h';
            }
            _ => {}
        }
    }

    fn osc_dispatch(&mut self, _params: &[&[u8]], _bell_terminated: bool) {
        // 标题/剪贴板等 OSC 序列忽略
    }

    fn esc_dispatch(&mut self, _intermediates: &[u8], _ignore: bool, byte: u8) {
        match byte {
            // DECSC：保存光标位置（conhost 清屏/程序重绘用）
            b'7' => self.0.saved_cursor = Some((self.0.cursor_x, self.0.cursor_y)),
            // DECRC：恢复光标位置
            b'8' => {
                if let Some((x, y)) = self.0.saved_cursor {
                    self.0.cursor_x = x.min(self.0.cols - 1);
                    self.0.cursor_y = y.min(self.0.rows - 1);
                }
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// 终端视图状态（传输 + 解析 + 输入）
// ---------------------------------------------------------------------------

/// 输入批量缓冲窗口（攒 10ms 一次 POST——降低输入→回显延迟）
const INPUT_FLUSH_MS: u64 = 10;

pub struct TermView {
    pub connected: bool,
    parser: Parser,
    screen: TermScreen,
    /// 待发送输入字节（键盘/粘贴/CPR 应答）
    pub input_pending: Vec<u8>,
    pub last_flush: Instant,
    /// 是否需要发送 resize（app.rs 帧驱动检查）
    pub resize_pending: Option<(u16, u16)>,
    /// 输出/输入后需要滚动到底部（顶对齐渲染 + 内容变化时跟随）
    pub need_scroll: bool,
    /// 最后一次成功发送的 resize 尺寸。发送成功后记录——flush 时若
    /// ConPTY 尺寸（last_sent）与屏幕网格不一致则补发（覆盖「连接前
    /// pending 丢失」：连接前 resize 只在本地网格生效，ConPTY 仍 100x30，
    /// 连接后若不补发 → shell 按 30 行渲染而显示区更少 → 内容错位）
    pub last_sent_size: Option<(u16, u16)>,
}

impl TermView {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            connected: false,
            parser: Parser::new(),
            screen: TermScreen::new(cols as usize, rows as usize),
            input_pending: Vec::new(),
            last_flush: Instant::now(),
            // 不预设 resize：首次渲染帧按实际窗口尺寸设置——预设默认尺寸
            // 会先发一次 100x30 再发实际尺寸（两次 resize → shell 两次重绘 →
            // 提示符叠加/双提示符）
            resize_pending: None,
            need_scroll: true,
            last_sent_size: None,
        }
    }

    /// 喂入输出字节（SSE 流）
    pub fn feed(&mut self, bytes: &[u8]) {
        self.need_scroll = true;
        self.parser.advance(&mut TermScreenHandler(&mut self.screen), bytes);
    }

    /// 追加输入字节（按键/粘贴）——批量缓冲，由 app 帧驱动 flush
    pub fn queue_input(&mut self, bytes: &[u8]) {
        self.need_scroll = true;
        self.input_pending.extend_from_slice(bytes);
    }

    /// 清空屏幕（重连/切换后避免旧内容叠加——TermView 跨页面保留）
    pub fn clear_screen(&mut self) {
        self.screen_mut().erase_screen_all();
    }

    /// 是否到 flush 时机（积攒 ≥INPUT_FLUSH_MS）
    pub fn input_due(&self) -> bool {
        !self.input_pending.is_empty() && self.last_flush.elapsed().as_millis() as u64 >= INPUT_FLUSH_MS
    }

    /// 取走待发输入（发送后调用）
    pub fn take_input(&mut self) -> Vec<u8> {
        self.last_flush = Instant::now();
        std::mem::take(&mut self.input_pending)
    }

    pub fn screen(&self) -> &TermScreen {
        &self.screen
    }
    pub fn screen_mut(&mut self) -> &mut TermScreen {
        &mut self.screen
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    use vte::Parser;

    fn render(bytes: &[u8]) -> Vec<String> {
        let mut screen = TermScreen::new(100, 30);
        let mut parser = Parser::new();
        parser.advance(&mut TermScreenHandler(&mut screen), bytes);
        (0..screen.rows())
            .map(|y| screen.line(y).iter().map(|c| c.ch).collect::<String>().trim_end().to_string())
            .filter(|l| !l.is_empty())
            .collect()
    }

    #[test]
    fn ps_readline_redraw_no_duplicate() {
        // PSReadLine 输入 '.' 后的真实字节（定位/重绘/错误信息）
        let bytes = b"\x1b[?25l\x1b[9;25H\x1b[9;23H\x1b[91m> \x1b[0m\x1b[37m.\r\n\x1b[37m>> \x1b[39;49m\x1b[0m\x1b[9;26H\x1b[?25h\x1b[?25l\x1b[11;1H\x1b[39;49m\x1b[0m\x1b[10;4H\x1b[?25h\x1b[10;4H\r\n\x1b[0m\x1b[0m\x1b[0;91m\x1b[0;91m\xe6\x89\x80\xe5\x9c\xa8\xe4\xbd\x8d\xe7\xbd\xae \xe8\xa1\x8c:1 \xe5\xad\x97\xe7\xac\xa6: 1\x1b[0m\x1b[0m";
        let lines = render(bytes);
        eprintln!("渲染行: {:?}", lines);
        let dup = lines.iter().filter(|l| l.contains("所在位置")).count();
        assert!(dup <= 1, "错误信息文本重复渲染（{} 次）", dup);
    }
}

#[cfg(test)]
mod tests2 {
    use super::*;
    use vte::Parser;

    #[test]
    fn cmd_full_startup_no_duplicate_prompt() {
        // cmd 完整启动渲染（7742B 真实字节）——检查提示符行不重复
        let bytes = std::fs::read(r"C:\Users\Middl\AppData\Local\Temp\cmd-startup.bin").unwrap_or_default();
        if bytes.is_empty() { return; }
        let mut screen = TermScreen::new(100, 30);
        let mut parser = Parser::new();
        parser.advance(&mut TermScreenHandler(&mut screen), &bytes);
        let mut dup = false;
        for y in 0..screen.rows() {
            let text: String = screen.line(y).iter().map(|c| c.ch).collect();
            if text.matches("D:").count() > 1 {
                dup = true;
                eprintln!("行 {y} 提示符重复: {:?}", text);
            }
        }
        assert!(!dup, "cmd 启动渲染出现提示符重复行");
    }
}
