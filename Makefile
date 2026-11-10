.PHONY: *
.DEFAULT_GOAL:=help

include tools/make/tools.mk
include tools/make/dependencies.mk
include tools/make/generate.mk
include tools/make/lint.mk
include tools/make/build.mk
include tools/make/test.mk
include tools/make/run.mk
include tools/make/help.mk

CMD?=
ACMD?=$(CMD) # alias for CMD so that it's the first alphabetically to expand in shell autocompletion
ARGS?=
BAZEL_CMD_ARGS?=
BAZEL_RUN_ARGS?=$(BAZEL_CMD_ARGS)
BAZEL_TEST_ARGS?=$(BAZEL_RUN_ARGS)
BAZEL_BUILD_ARGS?=$(BAZEL_RUN_ARGS)
BAZEL=bazelisk
BAZEL_TEST= $(BAZEL) test  $(BAZEL_TEST_ARGS)
BAZEL_BUILD=$(BAZEL) build $(BAZEL_BUILD_ARGS)
BAZEL_RUN=  $(BAZEL) run   $(BAZEL_RUN_ARGS)
BAZEL_QUERY=$(BAZEL) query $(BAZEL_CMD_ARGS)

DEPENDENCIES?=
