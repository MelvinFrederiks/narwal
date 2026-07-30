#include <cmath>
#include <iostream>
#include <string>
#include <map>
#include <unordered_map>

#include "json.hpp"
#include "zxcvbn.h"

using json = nlohmann::json;

// FLAGS:
// 76543210
//
// 0 - Track length
// 1 - Track zxcvbn score
// 2 - Track letter frequencies
// 3 - Track bigram frequencies
// 3-7 unused
//
// default = 0b00000011

const int FLAG_BIT_LENGTH = 1;
const int FLAG_BIT_ZXCVBN = 2;
const int FLAG_BIT_LETTER = 4;
const int FLAG_BIT_BIGRAM = 8;

json summarize(int flags) {
	// Track the amount of words with a certain score
	std::map<int, int> score_buckets = std::map<int, int>();
	std::map<int, int> length_buckets = std::map<int, int>();
	// TODO: do we want to use int as key or is char okay?
	std::map<char, int> letter_buckets = std::map<char, int>();
	std::map<char, std::map<char, int>> bigram_buckets = std::map<char, std::map<char, int>>();

	// Store the JSON objects in a map
	// Key is a string describing the type
	std::unordered_map<std::string, json> jsons = std::unordered_map<std::string, json>();
	if (flags & FLAG_BIT_ZXCVBN) {
		jsons["zxcvbn"] = {
			{"name", "zxcvbn"},
			{"type", "histogram"},
			{"axis", "Entropy (as determined by zxcvbn)"}
		};
	}
	if (flags & FLAG_BIT_LENGTH) {
		jsons["length"] = {
			{"name", "length"},
			{"type", "histogram"},
			{"axis", "Length"},
		};
	}
	if (flags & FLAG_BIT_LETTER) {
		jsons["letter"] = {
			{"name", "letters"},
			{"type", "histogram"},
			{"axis", "Letter"},
		};
	}
	if (flags & FLAG_BIT_BIGRAM) {
		jsons["bigram"] = {
			{"name", "bigrams"},
			{"type", "bivariate"},
			{"axis_x", "Left letter"}, // Todo bad names
			{"axis_y", "Right letter"},
		};
	}

	std::string line;
	while (std::cin >> line) {
		// Question here is do we want a demeuked list?
		std::string cleaned = "";
		for (char c : line) {
			if (c != '\n') {
				cleaned += c;
			}
		}
		if (flags & FLAG_BIT_ZXCVBN) {
			// guesses_log10 = entropy * log_10(2)
			// Round the result down.
			int score_bucket = (int) (ZxcvbnMatch(cleaned.c_str(), nullptr, nullptr) * log10(2));
			score_buckets[score_bucket]++;
		}

		if (flags & FLAG_BIT_LENGTH) {
			// Register str length
			int length_bucket = cleaned.length();
			length_buckets[length_bucket]++;
		}

		if (flags & FLAG_BIT_LETTER) {
			// Analyze letters
			for (char c : cleaned) {
				letter_buckets[c]++;
			}
		}
		
		if (flags & FLAG_BIT_BIGRAM) {
			// Collect the bigrams
			for (int i = 0; i < cleaned.length() - 1; i++) {
				char c1 = cleaned[i];
				char c2 = cleaned[i + 1];

				bigram_buckets[c1][c2]++;
			}
		}
	}
	
	// Write results to JSON object.
	if (flags & FLAG_BIT_ZXCVBN) {
		for (const auto& [bucket, amount] : score_buckets) {
			jsons["zxcvbn"]["values"][std::to_string(bucket)] = amount;
		}
	}

	if (flags & FLAG_BIT_LENGTH) {
		for (const auto& [bucket, amount] : length_buckets) {
			jsons["length"]["values"][std::to_string(bucket)] = amount;
		}
	}

	if (flags & FLAG_BIT_LETTER) {
		for (const auto& [bucket, amount] : letter_buckets) {
			// Convert char to string
			if (bucket < 0x80 && bucket >= 0x00) {
				// avoid non-utf-8 shenanigans
				// can probably be done smarter
				std::string s(1, bucket);
				jsons["letter"]["values"][s] = amount;
			}
		}
	}

	if (flags & FLAG_BIT_BIGRAM) {
		for (const auto& [bigram_left, value] : bigram_buckets) {
			for (const auto& [bigram_right, amount] : value) {
				// Convert char to string
				if (bigram_left < 0x80 && bigram_left >= 0x00 &&
					bigram_right < 0x80 && bigram_right >= 0x00) {
					// avoid non-utf-8 shenanigans
					// can probably be done smarter
					std::string left(1, bigram_left);
					std::string right(1, bigram_right);
					jsons["bigram"]["values"][left][right] = amount;
				}
			}
		}
	}
	
	std::vector<json> jvec = std::vector<json>();
	for (const auto& [name, data_j] : jsons) {
		jvec.push_back(data_j);
	}
	json j = jvec;
	return j;
}

int main(int argc, char** argv) {
	int flags = 0;
	// Parse args
	// 
	// -l Length histogram
	// -z Zxcvbn score
	// -f Single-letter (character) frequency analysis
	
	// Weird syntax, assign getopt result to flag and loop until flag is -1.
	char flag;
	while ((flag = getopt(argc, argv, "lzfbh")) != -1) {
		switch (flag) {
			case 'l':
				flags |= FLAG_BIT_LENGTH;
				break;
			case 'z':
				flags |= FLAG_BIT_ZXCVBN;
				break;
			case 'f':
				flags |= FLAG_BIT_LETTER;
				break;
			case 'b':
				flags |= FLAG_BIT_BIGRAM;
				break;
			case 'h':
				std::cout << "Usage: ./strength -[lzfh]\n\n";
				std::cout << "Accepts a list of words form stdin and outputs a JSON with analysis results\n\n";
				std::cout << "\t-l\tAnalyse length\n";
				std::cout << "\t-z\tAnalyze strength\n";
				std::cout << "\t-f\tAnalyze single-letter frequency\n";
				std::cout << "\t-b\tAnalyze bigram frequencies\n";
				return 0;
			default:
				flags = FLAG_BIT_LENGTH | FLAG_BIT_LETTER;
		}
	} 

	const auto& result = summarize(flags);

	std::cout << result.dump() << std::endl;
	return 0;
}
