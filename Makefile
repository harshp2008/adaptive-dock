UUID = adaptive-dock@harsh.patel
zip:
	cd extension/$(UUID) && zip -r ../../$(UUID).shell-extension.zip .
install:
	./install.sh
