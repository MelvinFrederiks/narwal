# Compilation instructions
# Dependencies are 
# 	zxcvbn-c (https://github.com/tsyrogit/zxcvbn-c)
# 	nlohmann:json (https://github.com/nlohmann/json)

# For zxcvbn: Clone the git repo into the directory scripts/zxcvbn-c/, and copy json.hpp into scripts/json/
# You can then run make.

strength: strength.o
	g++ -o strength strength.o zxcvbn-c/zxcvbn-c++inline.o 

strength.o: strength.cpp
	g++ strength.cpp -c -o strength.o -I zxcvbn-c/ --std=c++20 -I json/
