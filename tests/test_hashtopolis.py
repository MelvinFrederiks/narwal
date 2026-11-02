from pathlib import Path

from backend.hashtopolis_bridge import Pretask, find_file, parse_pretask
from backend.jobs.spec import MODES, Attack


def test_pretask_parser_mask_simple():
    mask_bf = Pretask(id=1, name="test_hashtopolis mask bf 5a", command="-a3 #HL# ?a?a?a?a?a")
    mask_bf_attack = Attack(
        label="test_hashtopolis mask bf 5a",
        mode="mask",
        attack_mode=3,
        mask="?a?a?a?a?a",
    )
    assert parse_pretask(mask_bf) == mask_bf_attack


def test_pretask_parser_mask_charset():
    # Also test for "-a 3", should parse the same as "-a3"
    mask_charset_bf = Pretask(
        id=2, name="test_hashtopolis mask bf 5ld", command="-a 3 #HL# ?1?1?1?1?1 -1 ?l?d"
    )
    mask_charset_bf_attack = Attack(
        label="test_hashtopolis mask bf 5ld",
        mode="mask",
        attack_mode=3,
        mask="?1?1?1?1?1",
        charsets=(("1", "?l?d"),),
    )
    assert parse_pretask(mask_charset_bf) == mask_charset_bf_attack


def test_pretask_parser_wordlist_simple():
    # -O should be ignored.
    wordlist = Pretask(
        id=3, name="test_hashtopolis wordlist rockyou", command="-O -a0 #HL# rockyou.txt"
    )
    wordlist_attack = Attack(
        label="test_hashtopolis wordlist rockyou",
        mode="wordlist",
        attack_mode=0,
        wordlist=find_file("rockyou.txt"),
    )

    assert parse_pretask(wordlist) == wordlist_attack


def test_pretask_parser_wordlist_rules():
    # -S and -w4 ignored, no attack mode passed (default to wordlist)
    rule = Pretask(
        id=4,
        name="test_hashtopolis rockyou + best66",
        command="#HL# rockyou.txt -O -S -w4 -r best66.rule",
    )
    rule_attack = Attack(
        label="test_hashtopolis rockyou + best66",
        mode="wordlist",
        attack_mode=0,
        wordlist=find_file("rockyou.txt"),
        rules=(find_file("best66.rule"),),
    )

    assert parse_pretask(rule) == rule_attack
