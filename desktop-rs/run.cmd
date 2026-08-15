@echo off
rem 运行 GCA Desktop (Rust 版)。已保存过登录信息则自动登录。
cd /d %~dp0
cargo run
